const TelegramBot = require('node-telegram-bot-api');
const OpenAI = require('openai');
const express = require('express');
const cron = require('node-cron');
const { Pool } = require('pg');

// Конфигурция
const config = {
    telegramToken: process.env.TELEGRAM_BOT_TOKEN,
    openaiApiKey: process.env.OPENAI_API_KEY,
    adminTelegramId: process.env.ADMIN_TELEGRAM_ID,
    databaseUrl: process.env.DATABASE_URL, // PostgreSQL URL от Render.com
    port: process.env.PORT || 3000,
    // ID вашей файнтюн модели
    finetuneModel: "ft:gpt-3.5-turbo-0125:personal:sonya-chat:BnNSGyGz"
};

// ИСПРАВЛЕНИЕ: Инициализация без автоматического polling
const bot = new TelegramBot(config.telegramToken, { polling: false });
const openai = new OpenAI({ apiKey: config.openaiApiKey });
const app = express();

// Флаг для предотвращения множественного запуска
let botStarted = false;

// PostgreSQL подключение
let pool;

async function connectToPostgreSQL() {
    try {
        pool = new Pool({
            connectionString: config.databaseUrl,
            ssl: config.databaseUrl ? { rejectUnauthorized: false } : false
        });
        
        // Проверяем подключение
        await pool.query('SELECT NOW()');
        console.log('✅ Подключено к PostgreSQL');
        
        // Создаем таблицу для диалогов
        await pool.query(`
            CREATE TABLE IF NOT EXISTS dialogs (
                user_id BIGINT PRIMARY KEY,
                user_name VARCHAR(255),
                messages JSONB NOT NULL,
                is_successful BOOLEAN DEFAULT FALSE,
                start_time TIMESTAMP DEFAULT NOW(),
                last_activity TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `);
        
        console.log('✅ Таблица диалогов готова');
        return true;
        
    } catch (error) {
        console.error('❌ Ошибка подключения к PostgreSQL:', error.message);
        console.log('🔄 Используем локальное хранилище в памяти');
        pool = null;
        return false;
    }
}

// База данных в памяти и PostgreSQL
const database = {
    conversations: new Map(), // Fallback для локального хранения
    dailyStats: {
        totalConversations: 0,
        successfulConversations: 0,
        date: new Date().toDateString()
    },
    successfulCases: [],
    // Защита от спама
    userCooldowns: new Map()
};

// Функция для сохранения диалога пользователя
async function saveUserDialog(userId, conversation) {
    try {
        if (pool) {
            // Сохраняем в PostgreSQL
            await pool.query(
                `INSERT INTO dialogs (user_id, user_name, messages, is_successful, start_time, last_activity, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, NOW())
                 ON CONFLICT (user_id) 
                 DO UPDATE SET 
                    user_name = $2,
                    messages = $3,
                    is_successful = $4,
                    last_activity = $6,
                    updated_at = NOW()`,
                [
                    userId,
                    conversation.userName,
                    JSON.stringify(conversation.messages),
                    conversation.isSuccessful,
                    conversation.startTime,
                    conversation.lastActivity
                ]
            );
            console.log(`💾 Диалог пользователя ${userId} сохранен в PostgreSQL`);
        } else {
            // Fallback: сохраняем в памяти
            database.conversations.set(userId, conversation);
            console.log(`💾 Диалог пользователя ${userId} сохранен в памяти`);
        }
    } catch (error) {
        console.error('❌ Ошибка сохранения диалога:', error.message);
        // Fallback к памяти
        database.conversations.set(userId, conversation);
        console.log(`💾 Fallback: диалог сохранен в памяти`);
    }
}

// Функция для загрузки диалога пользователя
async function loadUserDialog(userId) {
    try {
        if (pool) {
            // Загружаем из PostgreSQL
            const result = await pool.query(
                'SELECT * FROM dialogs WHERE user_id = $1',
                [userId]
            );
            
            if (result.rows.length > 0) {
                const row = result.rows[0];
                const conversation = {
                    userId: row.user_id,
                    userName: row.user_name,
                    messages: row.messages, // Уже JSON объект
                    isSuccessful: row.is_successful,
                    startTime: row.start_time,
                    lastActivity: row.last_activity
                };
                console.log(`📖 Диалог пользователя ${userId} загружен из PostgreSQL (${conversation.messages.length} сообщений)`);
                return conversation;
            }
        } else {
            // Fallback: загружаем из памяти
            const conversation = database.conversations.get(userId);
            if (conversation) {
                console.log(`📖 Диалог пользователя ${userId} загружен из памяти (${conversation.messages.length} сообщений)`);
                return conversation;
            }
        }
        
        console.log(`🆕 Создается новый диалог для пользователя ${userId}`);
        return null;
    } catch (error) {
        console.error('❌ Ошибка загрузки диалога:', error.message);
        // Fallback к памяти
        const conversation = database.conversations.get(userId);
        if (conversation) {
            console.log(`📖 Fallback: диалог загружен из памяти`);
            return conversation;
        }
        return null;
    }
}

// Функция для получения списка всех диалогов
async function getAllDialogs() {
    try {
        if (pool) {
            // Загружаем из PostgreSQL
            const result = await pool.query('SELECT * FROM dialogs ORDER BY last_activity DESC');
            return result.rows.map(row => ({
                userId: row.user_id,
                conversation: {
                    userId: row.user_id,
                    userName: row.user_name,
                    messages: row.messages,
                    isSuccessful: row.is_successful,
                    startTime: row.start_time,
                    lastActivity: row.last_activity
                }
            }));
        } else {
            // Fallback: загружаем из памяти
            const dialogs = [];
            for (const [userId, conversation] of database.conversations) {
                dialogs.push({ userId, conversation });
            }
            return dialogs;
        }
    } catch (error) {
        console.error('❌ Ошибка загрузки диалогов:', error.message);
        return [];
    }
}

// Приветственное сообщение
const welcomeMessage = "Привет! Я Соня — AI-рекрутер из Skill Hunter. 😊 Как могу к вам обращаться?";

// Функция для определения успешного диалога
function isSuccessfulConversation(messages) {
    const successKeywords = [
        'ссылка на сайт', 'сайт', 'презентация', 'демо', 'интересно', 
        'хочу купить', 'сколько стоит', 'как купить', 'покупка',
        'заинтересован', 'подходит', 'нужно', 'хочу узнать больше',
        'когда можем встретиться', 'контакты', 'связаться',
        'тест-драйв', 'попробовать', 'протестировать', 'бесплатно',
        'тарифы', 'цена', 'стоимость', 'подключить', 'интеграция',
        'api', 'внедрить', 'начать работать', 'заказать',
        'расскажите подробнее', 'как подключиться', 'регистрация'
    ];
    
    const lastMessages = messages.slice(-5); // Проверяем последние 5 сообщений  
    return lastMessages.some(msg => 
        msg.role === 'user' && 
        successKeywords.some(keyword => 
            msg.content.toLowerCase().includes(keyword)
        )
    );
}

// Функция для конвертации истории диалога в формат OpenAI
function convertToOpenAIMessages(conversationHistory) {
    const messages = [];

    // Добавляем всю историю диалога
    conversationHistory.forEach(msg => {
        if (msg.role === 'user' || msg.role === 'assistant') {
            messages.push({
                role: msg.role,
                content: msg.content
            });
        }
    });

    // Логируем для отладки
    console.log(`🔧 Сформировано ${messages.length} сообщений для файнтюн модели:`);
    console.log(`   - Сообщений пользователя: ${messages.filter(m => m.role === 'user').length}`);
    console.log(`   - Ответов ассистента: ${messages.filter(m => m.role === 'assistant').length}`);
    console.log(`   - Используется файнтюн модель: ${config.finetuneModel}`);

    return messages;
}

// Обработка сообщений
bot.on('message', async (msg) => {
    // ИСПРАВЛЕНИЕ 1: Проверяем, что сообщение содержит текст
    if (!msg.text) {
        console.log('📷 Получено не-текстовое сообщение (фото, стикер и т.д.), игнорируем');
        return;
    }

    const userId = msg.from.id;
    const userName = msg.from.first_name || 'Пользователь';
    const userMessage = msg.text;
    const timestamp = new Date();

    // Защита от спама - максимум 1 сообщение в 2 секунды
    const lastMessageTime = database.userCooldowns.get(userId);
    if (lastMessageTime && (timestamp - lastMessageTime) < 2000) {
        console.log(`⏰ Пользователь ${userId} отправляет сообщения слишком часто`);
        return;
    }
    database.userCooldowns.set(userId, timestamp);

    console.log(`📨 Сообщение от ${userName} (${userId}): ${userMessage?.substring(0, 50)}...`);

    // ВАЖНО: Проверяем админские команды ПЕРВЫМИ, до любой другой обработки
    if (userMessage === '/clear_db' && userId.toString() === config.adminTelegramId) {
        try {
            if (pool) {
                const result = await pool.query('DELETE FROM dialogs');
                await bot.sendMessage(userId, `✅ База данных PostgreSQL очищена!\n📊 Удалено записей: ${result.rowCount}\n🕐 Время: ${timestamp.toLocaleString('ru-RU')}`);
                console.log(`🗑️ База данных PostgreSQL очищена администратором. Удалено записей: ${result.rowCount}`);
            } else {
                database.conversations.clear();
                await bot.sendMessage(userId, `✅ База данных в памяти очищена!\n🕐 Время: ${timestamp.toLocaleString('ru-RU')}`);
                console.log(`🗑️ База данных в памяти очищена администратором`);
            }
        } catch (error) {
            await bot.sendMessage(userId, `❌ Ошибка очистки базы данных: ${error.message}`);
            console.error('❌ Ошибка очистки базы данных:', error);
        }
        return; // ВЫХОДИМ из функции, не обрабатываем как обычное сообщение
    }

    // Команда /start
    if (userMessage === '/start') {
        // Загружаем существующий диалог или создаем новый
        let conversation = await loadUserDialog(userId);
        
        if (!conversation) {
            // Создаем новый диалог
            conversation = {
                userId: userId,
                userName: userName,
                messages: [],
                isSuccessful: false,
                startTime: timestamp,
                lastActivity: timestamp
            };
            
            // Обновляем статистику только для новых пользователей
            if (database.dailyStats.date !== timestamp.toDateString()) {
                database.dailyStats = {
                    totalConversations: 1,
                    successfulConversations: 0,
                    date: timestamp.toDateString()
                };
            } else {
                database.dailyStats.totalConversations++;
            }

            // Добавляем приветственное сообщение
            conversation.messages.push({ 
                role: 'assistant', 
                content: welcomeMessage, 
                timestamp: timestamp 
            });
            
            await bot.sendMessage(userId, welcomeMessage);
        } else {
            // Пользователь уже существует - просто приветствуем
            await bot.sendMessage(userId, "С возвращением! Продолжаем наш диалог. Что вас интересует?");
        }

        conversation.lastActivity = timestamp;
        await saveUserDialog(userId, conversation);
        return;
    }

    // Загружаем диалог пользователя
    let conversation = await loadUserDialog(userId);
    
    if (!conversation) {
        // Если диалог не найден, создаем новый
        conversation = {
            userId: userId,
            userName: userName,
            messages: [],
            isSuccessful: false,
            startTime: timestamp,
            lastActivity: timestamp
        };
        
        // Добавляем приветственное сообщение в историю
        conversation.messages.push({ 
            role: 'assistant', 
            content: welcomeMessage, 
            timestamp: timestamp 
        });
    }

    // Добавляем сообщение пользователя
    conversation.messages.push({ 
        role: 'user', 
        content: userMessage, 
        timestamp: timestamp 
    });
    conversation.lastActivity = timestamp;

    try {
        // Конвертируем историю диалога в формат OpenAI
        const messages = convertToOpenAIMessages(conversation.messages);

        console.log(`🧠 Отправляем в файнтюн модель ${messages.length} сообщений`);
        console.log(`📝 Последние 3 сообщения в истории:`, 
            conversation.messages.slice(-3).map(m => `${m.role}: ${m.content.substring(0, 50)}...`)
        );

        // ИСПРАВЛЕНИЕ 2: Упрощенный системный промпт
        const systemPrompt = `Ты Соня — AI-рекрутер из Skill Hunter. 

КОНТЕКСТ: К тебе приходят представители компаний, у которых открыта вакансия рекрутера.

ЦЕЛЬ: Подвести к тому, что Skill Hunter решает задачи рекрутера дешевле и быстрее.

ВОРОНКА ПРОДАЖ:
1. Знакомство → "Какие задачи планируете поставить рекрутеру?"
2. Подведи к стандартным задачам: размещение вакансий, разбор резюме, согласование интервью
3. Выясни время: "Сколько времени рекрутер будет тратить на эти задачи?" 
4. Выясни бюджет: "Какую зарплату планируете рекрутеру?"
5. Презентация: "А что если все эти задачи Skill Hunter будет делать за [меньшую сумму] и экономить [количество] часов?"
6. УСПЕХ = отправка ссылки на https://skillhunter.ai

Ключевые фразы:
- "Значит, рекрутер будет размещать вакансии и разбирать резюме?"
- "Сколько времени это займет у рекрутера в день?"
- "А если Skill Hunter возьмет эти задачи на себя?"

ЦЕЛЬ: Ссылка на сайт = успешный диалог`;

        // Отправляем запрос в OpenAI с файнтюн моделью
        const response = await openai.chat.completions.create({
            model: config.finetuneModel,
            messages: [
                {
                    role: "system", 
                    content: systemPrompt
                },
                ...messages
            ],
            max_tokens: 500,
            temperature: 0.7
        });

        const botResponse = response.choices[0].message.content || 'Извините, не удалось получить ответ.';

        // Логируем информацию об ответе
        console.log(`✅ Получен ответ от файнтюн модели (${botResponse.length} символов)`);
        console.log(`💰 Использовано токенов: ${response.usage?.total_tokens || 'неизвестно'}`);
        console.log(`🧠 Модель: ${config.finetuneModel}`);
        
        // Проверяем, что ответ не пустой
        if (!botResponse || botResponse.trim() === '') {
            console.error('❌ Пустой ответ от файнтюн модели');
            await bot.sendMessage(userId, 'Извините, произошла ошибка. Попробуйте еще раз.');
            return;
        }

        // Добавляем ответ бота
        conversation.messages.push({ 
            role: 'assistant', 
            content: botResponse, 
            timestamp: timestamp 
        });

        // Проверяем успешность диалога
        if (!conversation.isSuccessful && isSuccessfulConversation(conversation.messages)) {
            conversation.isSuccessful = true;
            database.dailyStats.successfulConversations++;

            // Сохраняем успешный кейс для самообучения
            const successfulCase = {
                userId: userId,
                timeToSuccess: conversation.messages.length,
                keyPhrases: extractKeyPhrases(conversation.messages),
                outcome: 'Клиент проявил интерес',
                timestamp: timestamp
            };
            database.successfulCases.push(successfulCase);

            // Ограничиваем количество сохраненных успешных кейсов
            if (database.successfulCases.length > 50) {
                database.successfulCases.shift();
            }

            console.log(`🎯 Успешный диалог с пользователем ${userId} (${userName})`);
        }

        // Сохраняем обновленный диалог
        await saveUserDialog(userId, conversation);

        // Отправляем ответ пользователю
        await bot.sendMessage(userId, botResponse);

    } catch (error) {
        console.error('Ошибка при обработке сообщения:', error);
        
        // ИСПРАВЛЕНИЕ 3: Улучшенная обработка ошибок
        let errorMessage = 'Извините, произошла ошибка. Попробуйте еще раз.';
        
        if (error.response) {
            // Ошибка от OpenAI API
            const statusCode = error.response.status;
            const errorData = error.response.data;
            
            console.error(`❌ OpenAI API Error ${statusCode}:`, errorData);
            
            if (statusCode === 404) {
                console.error('❌ Файнтюн модель не найдена! Проверьте ID модели:', config.finetuneModel);
                errorMessage = 'Технические неполадки с AI моделью. Попробуйте позже.';
            } else if (statusCode === 429) {
                console.error('❌ Превышен лимит запросов API OpenAI');
                errorMessage = 'Слишком много запросов. Попробуйте через минуту.';
            } else if (statusCode === 401) {
                console.error('❌ Неверный API ключ OpenAI');
                errorMessage = 'Технические неполадки с авторизацией. Попробуйте позже.';
            } else if (errorData?.error?.code === 'insufficient_quota') {
                console.error('❌ Превышен лимит API OpenAI');
                errorMessage = 'Временные технические ограничения. Попробуйте через несколько минут.';
            }
        } else if (error.code === 'ECONNRESET' || error.code === 'ENOTFOUND') {
            console.error('❌ Проблемы с сетевым соединением');
            errorMessage = 'Проблемы с соединением. Попробуйте еще раз.';
        }
        
        await bot.sendMessage(userId, errorMessage);
    }
});

// Функция для извлечения ключевых фраз из успешных диалогов
function extractKeyPhrases(messages) {
    const userMessages = messages.filter(msg => msg.role === 'user');
    const lastUserMessages = userMessages.slice(-3);
    
    const keyWords = [];
    lastUserMessages.forEach(msg => {
        const words = msg.content.toLowerCase().split(' ');
        words.forEach(word => {
            if (word.length > 4 && !keyWords.includes(word)) {
                keyWords.push(word);
            }
        });
    });
    
    return keyWords.slice(0, 10); // Возвращаем первые 10 ключевых слов
}

// ИСПРАВЛЕНИЕ 4: Более надежный cron с проверкой часового пояса
// Ежедневный отчет в 18:00 по московскому времени (GMT+3)
cron.schedule('0 15 * * *', async () => { // 15:00 UTC = 18:00 MSK
    const today = new Date().toDateString();
    const stats = database.dailyStats;
    
    if (stats.date === today) {
        const conversionRate = stats.totalConversations > 0 
            ? Math.round((stats.successfulConversations / stats.totalConversations) * 100)
            : 0;

        // Получаем общую статистику из файлов
        const allDialogs = await getAllDialogs();
        const totalUsers = allDialogs.length;
        const successfulUsers = allDialogs.filter(d => d.conversation.isSuccessful).length;

        const reportMessage = `📊 ЕЖЕДНЕВНЫЙ ОТЧЕТ SKILL HUNTER BOT
📅 Дата: ${today}
🤖 Модель: Файнтюн Соня (${config.finetuneModel.split(':')[3] || 'custom'})

💬 Проведено диалогов сегодня: ${stats.totalConversations}
✅ Заинтересовалось сегодня: ${stats.successfulConversations} человек
📈 Конверсия за день: ${conversionRate}%

📈 ОБЩАЯ СТАТИСТИКА:
👥 Всего пользователей: ${totalUsers}
🎯 Успешных диалогов: ${successfulUsers}
📊 Общая конверсия: ${totalUsers > 0 ? Math.round((successfulUsers / totalUsers) * 100) : 0}%

${stats.successfulConversations > 0 ? '🎯 Успешные диалоги сегодня!' : '🔄 Работаем над улучшением результатов'}`;

        try {
            await bot.sendMessage(config.adminTelegramId, reportMessage);
            console.log('📊 Ежедневный отчет отправлен администратору');
        } catch (error) {
            console.error('❌ Ошибка отправки отчета:', error);
        }
    }
}, {
    timezone: "Europe/Moscow"
});

// ИСПРАВЛЕНИЕ 5: Значительно улучшенная обработка ошибок бота
bot.on('error', (error) => {
    console.error('❌ Ошибка Telegram бота:', error);
    
    if (error.code === 'ETELEGRAM' && error.response?.body?.error_code === 409) {
        console.log('⚠️  Обнаружен конфликт: другой экземпляр бота уже запущен');
        console.log('🔄 Останавливаем polling и перезапускаем через 10 секунд...');
        
        bot.stopPolling().then(() => {
            setTimeout(() => {
                startBotSafely();
            }, 10000);
        }).catch(err => {
            console.error('❌ Ошибка остановки polling:', err);
        });
    } else if (error.code === 'EFATAL') {
        console.log('🔄 Фатальная ошибка. Перезапуск polling через 5 секунд...');
        setTimeout(() => {
            startBotSafely();
        }, 5000);
    }
});

bot.on('polling_error', (error) => {
    console.error('❌ Ошибка polling:', error);
    
    if (error.code === 'ETELEGRAM' && error.response?.body?.error_code === 409) {
        console.log('⚠️  Конфликт polling: другой экземпляр уже получает обновления');
        console.log('🛑 Останавливаем текущий polling...');
        
        bot.stopPolling().then(() => {
            console.log('✅ Polling остановлен. Ждем 15 секунд перед повторным запуском...');
            setTimeout(() => {
                startBotSafely();
            }, 15000);
        }).catch(err => {
            console.error('❌ Ошибка остановки polling:', err);
        });
    } else {
        console.log('🔄 Попытка перезапуска через 5 секунд...');
        setTimeout(() => {
            startBotSafely();
        }, 5000);
    }
});

// Функция безопасного запуска бота
async function startBotSafely() {
    if (botStarted) {
        console.log('⚠️  Бот уже запущен, пропускаем повторный запуск');
        return;
    }
    
    try {
        console.log('🚀 Попытка запуска Telegram бота...');
        
        // Проверяем, работает ли бот, получив информацию о нем
        const botInfo = await bot.getMe();
        console.log(`🤖 Бот подключен: @${botInfo.username} (${botInfo.first_name})`);
        
        // Останавливаем существующий polling если есть
        await bot.stopPolling();
        console.log('🛑 Предыдущий polling остановлен');
        
        // Запускаем новый polling
        await bot.startPolling();
        botStarted = true;
        console.log('✅ Telegram бот успешно запущен!');
        
    } catch (error) {
        console.error('❌ Ошибка запуска бота:', error);
        
        if (error.code === 'ETELEGRAM' && error.response?.body?.error_code === 409) {
            console.log('⚠️  Другой экземпляр бота уже активен. Ждем 30 секунд...');
            setTimeout(() => {
                startBotSafely();
            }, 30000);
        } else {
            console.log('🔄 Повторная попытка через 10 секунд...');
            setTimeout(() => {
                startBotSafely();
            }, 10000);
        }
    }
}

// Express сервер для Render.com
app.use(express.json());

app.get('/', (req, res) => {
    res.send(`
        <h1>🤖 Skill Hunter Telegram Bot</h1>
        <p>✅ Бот активен и работает</p>
        <p>🧠 Модель: ${config.finetuneModel}</p>
        <p>💾 Хранилище: ${pool ? 'PostgreSQL' : 'Память'}</p>
        <p><a href="/dialogs">📊 Посмотреть диалоги</a></p>
        <p><a href="/stats">📈 Статистика API</a></p>
    `);
});

app.get('/dialogs', async (req, res) => {
    try {
        const allDialogs = await getAllDialogs();
        
        let html = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>Диалоги Skill Hunter Bot</title>
            <style>
                body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
                .dialog { background: white; margin: 20px 0; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
                .dialog-header { background: #2196F3; color: white; padding: 10px; margin: -20px -20px 20px -20px; border-radius: 8px 8px 0 0; }
                .message { margin: 10px 0; padding: 10px; border-radius: 5px; }
                .user-message { background: #e3f2fd; border-left: 4px solid #2196F3; }
                .bot-message { background: #f3e5f5; border-left: 4px solid #9c27b0; }
                .timestamp { font-size: 12px; color: #666; }
                .success { color: #4caf50; font-weight: bold; }
                .stats { background: #fff; padding: 20px; border-radius: 8px; margin-bottom: 20px; }
                .storage-info { background: #fff3cd; padding: 10px; border-radius: 5px; margin-bottom: 20px; border-left: 4px solid #ffc107; }
                .model-info { background: #d1ecf1; padding: 10px; border-radius: 5px; margin-bottom: 20px; border-left: 4px solid #17a2b8; }
                .admin-panel { background: #f8f9fa; padding: 15px; border-radius: 5px; margin-bottom: 20px; border: 1px solid #dee2e6; }
            </style>
        </head>
        <body>
            <div class="model-info">
                <strong>🧠 AI Модель:</strong> Файнтюн Соня (${config.finetuneModel})
            </div>
            
            <div class="storage-info">
                <strong>💾 Хранилище:</strong> ${pool ? 'PostgreSQL (постоянное)' : 'Память (временное, сбрасывается при перезапуске)'}
            </div>
            
            <div class="admin-panel">
                <h3>🔧 Панель администратора</h3>
                <p>Для очистки базы данных напишите боту команду: <code>/clear_db</code></p>
                <p><small>Команда работает только для администратора (ID: ${config.adminTelegramId})</small></p>
            </div>
            
            <div class="stats">
                <h1>📊 Статистика диалогов Skill Hunter</h1>
                <p><strong>Всего пользователей:</strong> ${allDialogs.length}</p>
                <p><strong>Успешных диалогов:</strong> ${allDialogs.filter(d => d.conversation.isSuccessful).length}</p>
                <p><strong>Конверсия:</strong> ${allDialogs.length > 0 ? Math.round((allDialogs.filter(d => d.conversation.isSuccessful).length / allDialogs.length) * 100) : 0}%</p>
            </div>
        `;
        
        allDialogs.forEach(({userId, conversation}) => {
            const lastActivity = new Date(conversation.lastActivity || conversation.startTime).toLocaleString('ru-RU');
            const messagesCount = conversation.messages.length;
            const successBadge = conversation.isSuccessful ? '<span class="success">✅ УСПЕШНЫЙ</span>' : '';
            
            html += `
            <div class="dialog">
                <div class="dialog-header">
                    <h3>👤 ${conversation.userName} (ID: ${userId}) ${successBadge}</h3>
                    <p>Последняя активность: ${lastActivity} | Сообщений: ${messagesCount}</p>
                </div>
            `;
            
            conversation.messages.forEach(msg => {
                const messageClass = msg.role === 'user' ? 'user-message' : 'bot-message';
                const roleIcon = msg.role === 'user' ? '👤' : '🤖';
                const timestamp = new Date(msg.timestamp).toLocaleString('ru-RU');
                
                html += `
                <div class="message ${messageClass}">
                    <strong>${roleIcon} ${msg.role === 'user' ? conversation.userName : 'Соня (Файнтюн)'}:</strong><br>
                    ${msg.content.replace(/\n/g, '<br>')}
                    <div class="timestamp">${timestamp}</div>
                </div>
                `;
            });
            
            html += '</div>';
        });
        
        html += '</body></html>';
        res.send(html);
        
    } catch (error) {
        res.status(500).send(`Ошибка загрузки диалогов: ${error.message}`);
    }
});

app.get('/stats', async (req, res) => {
    try {
        const allDialogs = await getAllDialogs();
        const totalUsers = allDialogs.length;
        const successfulUsers = allDialogs.filter(d => d.conversation.isSuccessful).length;
        const totalMessages = allDialogs.reduce((sum, d) => sum + d.conversation.messages.length, 0);
        
        res.json({
            dailyStats: database.dailyStats,
            totalUsers: totalUsers,
            successfulUsers: successfulUsers,
            totalMessages: totalMessages,
            overallConversion: totalUsers > 0 ? Math.round((successfulUsers / totalUsers) * 100) : 0,
            successfulCases: database.successfulCases.length,
            storageType: pool ? 'PostgreSQL' : 'Memory',
            aiModel: config.finetuneModel,
            modelType: 'Fine-tuned Sonya'
        });
    } catch (error) {
        res.status(500).json({ error: 'Ошибка загрузки статистики', details: error.message });
    }
});

// ИСПРАВЛЕНИЕ 6: Добавляем middleware для обработки ошибок Express
app.use((err, req, res, next) => {
    console.error('❌ Express Error:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

// Запуск сервера
app.listen(config.port, async () => {
    // Подключаемся к PostgreSQL при запуске
    const dbConnected = await connectToPostgreSQL();
    
    console.log(`🚀 Сервер запущен на порту ${config.port}`);
    console.log('🧠 AI Модель:', config.finetuneModel);
    console.log('💾 Система хранения:', pool ? 'PostgreSQL (постоянное)' : 'Память (временное)');
    
    if (dbConnected) {
        console.log('🎉 База данных готова к работе!');
    }
    
    // Запускаем бота безопасно
    console.log('🤖 Запуск Telegram бота...');
    startBotSafely();
    
    console.log('✅ Соня готова к общению с файнтюн обучением!');
});

// ИСПРАВЛЕНИЕ 7: Улучшенная обработка завершения процесса
process.on('SIGINT', async () => {
    console.log('🛑 Получен сигнал SIGINT, остановка бота...');
    try {
        botStarted = false;
        await bot.stopPolling();
        console.log('🤖 Telegram polling остановлен');
        
        if (pool) {
            await pool.end();
            console.log('💾 Соединение с PostgreSQL закрыто');
        }
        console.log('✅ Бот остановлен корректно');
    } catch (error) {
        console.error('❌ Ошибка при остановке:', error);
    }
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('🛑 Получен сигнал SIGTERM, остановка бота...');
    try {
        botStarted = false;
        await bot.stopPolling();
        console.log('🤖 Telegram polling остановлен');
        
        if (pool) {
            await pool.end();
            console.log('💾 Соединение с PostgreSQL закрыто');
        }
        console.log('✅ Бот остановлен корректно');
    } catch (error) {
        console.error('❌ Ошибка при остановке:', error);
    }
    process.exit(0);
});

// ИСПРАВЛЕНИЕ 8: Добавляем обработку неперехваченных исключений
process.on('uncaughtException', (error) => {
    console.error('❌ Неперехваченное исключение:', error);
    // Не завершаем процесс сразу, логируем и продолжаем
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Неперехваченное отклонение промиса:', reason);
    console.error('🔍 Промис:', promise);
    // Не завершаем процесс сразу, логируем и продолжаем
});
