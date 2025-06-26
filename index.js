const TelegramBot = require('node-telegram-bot-api');
const OpenAI = require('openai');
const express = require('express');
const cron = require('node-cron');
const { MongoClient } = require('mongodb');

// Конфигурция (заполните своими данными)
const config = {
    telegramToken: process.env.TELEGRAM_BOT_TOKEN, // Получите у @BotFather
    openaiApiKey: process.env.OPENAI_API_KEY,      // Ваш OpenAI API ключ
    adminTelegramId: process.env.ADMIN_TELEGRAM_ID, // Ваш Telegram ID для отчетов
    mongoUrl: process.env.MONGODB_URL || 'mongodb://localhost:27017/skillhunter', // MongoDB URL
    port: process.env.PORT || 3000
};

// Инициализация
const bot = new TelegramBot(config.telegramToken, { polling: true });
const openai = new OpenAI({ apiKey: config.openaiApiKey });
const app = express();

// MongoDB подключение
let db;
let dialogsCollection;

async function connectToMongoDB() {
    try {
        const client = new MongoClient(config.mongoUrl);
        await client.connect();
        db = client.db('skillhunter');
        dialogsCollection = db.collection('dialogs');
        console.log('✅ Подключено к MongoDB');
        
        // Создаем индекс для быстрого поиска по userId
        await dialogsCollection.createIndex({ userId: 1 });
        
    } catch (error) {
        console.error('❌ Ошибка подключения к MongoDB:', error);
        // Fallback к локальному хранилищу
        console.log('🔄 Используем локальное хранилище в памяти');
        db = null;
    }
}

// База данных в памяти и MongoDB
const database = {
    conversations: new Map(), // Fallback для локального хранения
    dailyStats: {
        totalConversations: 0,
        successfulConversations: 0,
        date: new Date().toDateString()
    },
    successfulCases: [] // Для самообучения
};

// Функция для сохранения диалога пользователя
async function saveUserDialog(userId, conversation) {
    try {
        if (db && dialogsCollection) {
            // Сохраняем в MongoDB
            await dialogsCollection.replaceOne(
                { userId: userId },
                {
                    userId: userId,
                    ...conversation,
                    updatedAt: new Date()
                },
                { upsert: true }
            );
            console.log(`💾 Диалог пользователя ${userId} сохранен в MongoDB`);
        } else {
            // Fallback: сохраняем в памяти
            database.conversations.set(userId, conversation);
            console.log(`💾 Диалог пользователя ${userId} сохранен в памяти`);
        }
    } catch (error) {
        console.error('❌ Ошибка сохранения диалога:', error);
        // Fallback к памяти
        database.conversations.set(userId, conversation);
    }
}

// Функция для загрузки диалога пользователя
async function loadUserDialog(userId) {
    try {
        if (db && dialogsCollection) {
            // Загружаем из MongoDB
            const conversation = await dialogsCollection.findOne({ userId: userId });
            if (conversation) {
                console.log(`📖 Диалог пользователя ${userId} загружен из MongoDB (${conversation.messages.length} сообщений)`);
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
        console.error('❌ Ошибка загрузки диалога:', error);
        // Fallback к памяти
        const conversation = database.conversations.get(userId);
        if (conversation) {
            return conversation;
        }
        return null;
    }
}

// Функция для получения списка всех диалогов
async function getAllDialogs() {
    try {
        if (db && dialogsCollection) {
            // Загружаем из MongoDB
            const dialogs = await dialogsCollection.find({}).toArray();
            return dialogs.map(d => ({ userId: d.userId, conversation: d }));
        } else {
            // Fallback: загружаем из памяти
            const dialogs = [];
            for (const [userId, conversation] of database.conversations) {
                dialogs.push({ userId, conversation });
            }
            return dialogs;
        }
    } catch (error) {
        console.error('❌ Ошибка загрузки диалогов:', error);
        return [];
    }
}

// База знаний компании Skill Hunter
const companyKnowledge = `
ИНФОРМАЦИЯ О КОМПАНИИ:
Название: Skill Hunter
Продукт: AI-сервис для предсказания прохождения испытательного срока кандидатами

ЧТО ТАКОЕ SKILL HUNTER:
Skill Hunter — это AI-сервис, который предсказывает, пройдёт ли кандидат испытательный срок.
Анализирует интервью кандидата (текст, аудио, Zoom, Telegram) и выявляет поведенческие риски, 
которые не видны в резюме и даже на первом впечатлении.

АНАЛИЗИРУЕТ:
- инициативность, обучаемость, тревожность
- фасадную вежливость и поверхностность
- склонность к конфликтам и неэффективности

РЕЗУЛЬТАТ:
- Вердикт: Подходит / Ограниченно / Не подходит
- Оценки по ключевым метрикам (от 1 до 5)
- Поведенческие риски с цитатами
- Тест на доверие: можно ли поручиться за кандидата на 1–2 года

ФУНКЦИОНАЛ:
- Принимает интервью в любом формате: текст, голос, Zoom-записи
- Автоматически анализирует до 50 поведенческих индикаторов
- Выдаёт готовый отчёт с вердиктом, без участия HR
- Работает быстро: от интервью до отчёта — 3 минуты
- Интегрируется с hh.ru, CRM и ATS (на тарифах с API)

ЭФФЕКТИВНОСТЬ:
- Точность выше 89% по ретроспективному анализу (400+ кандидатов)
- Помогает избежать найма "не тех" людей ещё до выхода в работу
- Позволяет HR сэкономить до 20 часов в месяц на ручной оценке интервью

СТАТИСТИКА ПРОБЛЕМ:
- 46% увольнений происходят из-за проблем с soft skills
- 82% HR-менеджеров признают, что оценка soft skills — самая сложная часть подбора
- 1 из 3 сотрудников не проходит испытательный срок
- Средняя стоимость неправильного найма — от 500 000 до 3 млн рублей

ТАРИФЫ:
- Тест-драйв — 0 ₽ / 10 интервью
- Старт — 5 000 ₽ / 10 интервью
- Базовый — 25 000 ₽ / мес / 100 интервью
- Командный — кастомный, с API и дообучением

ДЛЯ КОГО ПОЛЕЗНО:
HR-специалистам: Анализ до 10 раз быстрее, видны реальные риски
Руководителям: Исключение слабых ещё до выхода, снижение текучести
Основателям: Экономия до 3 млн ₽ в год, минимизация ошибок при масштабировании

СТРАТЕГИЯ ПРОДАЖ:
1. Выявить боли клиента в найме (текучесть, долгий поиск, ошибки найма)
2. Показать статистику проблем (46% увольнений из-за soft skills)
3. Предложить решение с конкретными цифрами (89% точность, экономия до 3 млн)
4. Предложить бесплатный тест-драйв (10 интервью бесплатно)
5. Работать с возражениями данными и кейсами
6. Закрывать на тест-драйв или презентацию
`;

// Приветственное сообщение
const welcomeMessage = "Добрый день! Я ИИ рекрутер Александра. Я знаю, кто из кандидатов не пройдет испытательный срок. Рассказать вам мой секрет?";

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

// Функция для создания промпта с учетом истории и самообучения
function createSystemPrompt() {
    let learningPrompt = '';
    
    // Добавляем знания из успешных кейсов
    if (database.successfulCases.length > 0) {
        const recentSuccessfulCases = database.successfulCases.slice(-3);
        learningPrompt = `
УСПЕШНЫЕ СТРАТЕГИИ (учитесь на этих примерах):
${recentSuccessfulCases.map(successCase => `
- Ключевые фразы: ${successCase.keyPhrases.join(', ')}
- Результат: ${successCase.outcome}
- Время до успеха: ${successCase.timeToSuccess} сообщений
`).join('\n')}
`;
    }

    return `${companyKnowledge}

${learningPrompt}

ИНСТРУКЦИИ:
- Вы AI-рекрутер Александра из компании Skill Hunter
- Общайтесь профессионально, но дружелюбно
- Задавайте вопросы о проблемах клиента в найме
- Показывайте конкретную пользу и ROI (89% точность, экономия до 3 млн ₽)
- Предлагайте бесплатный тест-драйв (10 интервью бесплатно)
- Используйте знания из успешных кейсов выше
- Отвечайте на основе ВСЕЙ истории диалога с этим пользователем`;
}

// Функция для конвертации истории диалога в формат OpenAI
function convertToOpenAIMessages(conversationHistory) {
    const messages = [
        {
            role: "system",
            content: createSystemPrompt()
        }
    ];

    // Добавляем всю историю диалога
    conversationHistory.forEach(msg => {
        if (msg.role === 'user' || msg.role === 'assistant') {
            messages.push({
                role: msg.role,
                content: msg.content
            });
        }
    });

    return messages;
}

// Обработка сообщений
bot.on('message', async (msg) => {
    const userId = msg.from.id;
    const userName = msg.from.first_name || 'Пользователь';
    const userMessage = msg.text;
    const timestamp = new Date();

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

        console.log(`🧠 Отправляем в GPT ${messages.length} сообщений (включая системный промпт)`);
        console.log(`📝 Последние 3 сообщения в истории:`, 
            conversation.messages.slice(-3).map(m => `${m.role}: ${m.content.substring(0, 50)}...`)
        );

        // Отправляем запрос в OpenAI с полной историей
        const response = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages: messages,
            max_tokens: 500,
            temperature: 0.7
        });

        const botResponse = response.choices[0].message.content;

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
        await bot.sendMessage(userId, 'Извините, произошла ошибка. Попробуйте еще раз.');
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

// Ежедневный отчет в 18:00 по московскому времени (GMT+3)
cron.schedule('0 18 * * *', async () => {
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

        const reportMessage = `📊 ЕЖЕДНЕВНЫЙ ОТЧЕТ
📅 Дата: ${today}
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
        } catch (error) {
            console.error('Ошибка отправки отчета:', error);
        }
    }
});

// Обработка ошибок
bot.on('error', (error) => {
    console.error('Ошибка бота:', error);
});

// Express сервер для Render.com
app.use(express.json());

app.get('/', (req, res) => {
    res.send('Telegram Sales Bot работает!');
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
            </style>
        </head>
        <body>
            <div class="storage-info">
                <strong>💾 Хранилище:</strong> ${db ? 'MongoDB (постоянное)' : 'Память (временное, сбрасывается при перезапуске)'}
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
                    <strong>${roleIcon} ${msg.role === 'user' ? conversation.userName : 'Skill Hunter Bot'}:</strong><br>
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
            storageType: db ? 'MongoDB' : 'Memory'
        });
    } catch (error) {
        res.status(500).json({ error: 'Ошибка загрузки статистики', details: error.message });
    }
});

// Запуск сервера
app.listen(config.port, async () => {
    // Подключаемся к MongoDB при запуске
    await connectToMongoDB();
    
    console.log(`Сервер запущен на порту ${config.port}`);
    console.log('Telegram бот активен!');
    console.log('Система хранения:', db ? 'MongoDB (постоянное)' : 'Память (временное)');
});

// Обработка завершения процесса
process.on('SIGINT', () => {
    console.log('Остановка бота...');
    bot.stopPolling();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('Остановка бота...');
    bot.stopPolling();
    process.exit(0);
});
