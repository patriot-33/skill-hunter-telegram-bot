const TelegramBot = require('node-telegram-bot-api');
const OpenAI = require('openai');
const express = require('express');
const cron = require('node-cron');

// Конфигурция (заполните своими данными)
const config = {
    telegramToken: process.env.TELEGRAM_BOT_TOKEN, // Получите у @BotFather
    openaiApiKey: process.env.OPENAI_API_KEY,      // Ваш OpenAI API ключ
    adminTelegramId: process.env.ADMIN_TELEGRAM_ID, // Ваш Telegram ID для отчетов
    port: process.env.PORT || 3000
};

// Инициализация
const bot = new TelegramBot(config.telegramToken, { polling: true });
const openai = new OpenAI({ apiKey: config.openaiApiKey });
const app = express();

// База данных в памяти (для production используйте MongoDB или PostgreSQL)
const database = {
    conversations: new Map(), // userId -> {messages: [], isSuccessful: false, startTime: Date}
    dailyStats: {
        totalConversations: 0,
        successfulConversations: 0,
        date: new Date().toDateString()
    },
    successfulCases: [] // Для самообучения
};

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
function createPrompt(userMessage, conversationHistory, userId) {
    let learningPrompt = '';
    
    // Добавляем знания из успешных кейсов
    if (database.successfulCases.length > 0) {
        const recentSuccessfulCases = database.successfulCases.slice(-3);
        learningPrompt = `
УСПЕШНЫЕ СТРАТЕГИИ (учитесь на этих примерах):
${recentSuccessfulCases.map(case => `
- Ключевые фразы: ${case.keyPhrases.join(', ')}
- Результат: ${case.outcome}
- Время до успеха: ${case.timeToSuccess} сообщений
`).join('\n')}
`;
    }

    return `${companyKnowledge}

${learningPrompt}

ИНСТРУКЦИИ:
- Вы AI-рекрутер Александра
- Общайтесь профессионально, но дружелюбно
- Задавайте вопросы о проблемах клиента в найме
- Показывайте конкретную пользу и ROI
- Предлагайте демо/презентацию
- Используйте знания из успешных кейсов выше

ИСТОРИЯ ДИАЛОГА:
${conversationHistory.map(msg => `${msg.role}: ${msg.content}`).join('\n')}

ТЕКУЩЕЕ СООБЩЕНИЕ ПОЛЬЗОВАТЕЛЯ: ${userMessage}

Ответьте как AI-рекрутер Александра:`;
}

// Обработка сообщений
bot.on('message', async (msg) => {
    const userId = msg.from.id;
    const userName = msg.from.first_name || 'Пользователь';
    const userMessage = msg.text;
    const timestamp = new Date();

    // Команда /start
    if (userMessage === '/start') {
        // Инициализация нового диалога
        database.conversations.set(userId, {
            messages: [{ role: 'assistant', content: welcomeMessage, timestamp }],
            isSuccessful: false,
            startTime: timestamp,
            userName: userName
        });
        
        // Обновляем статистику
        if (database.dailyStats.date !== timestamp.toDateString()) {
            database.dailyStats = {
                totalConversations: 1,
                successfulConversations: 0,
                date: timestamp.toDateString()
            };
        } else {
            database.dailyStats.totalConversations++;
        }

        await bot.sendMessage(userId, welcomeMessage);
        return;
    }

    // Получаем историю диалога
    let conversation = database.conversations.get(userId);
    if (!conversation) {
        conversation = {
            messages: [],
            isSuccessful: false,
            startTime: timestamp,
            userName: userName
        };
        database.conversations.set(userId, conversation);
    }

    // Добавляем сообщение пользователя
    conversation.messages.push({ role: 'user', content: userMessage, timestamp });

    try {
        // Создаем промпт для OpenAI
        const prompt = createPrompt(userMessage, conversation.messages, userId);

        // Отправляем запрос в OpenAI
        const response = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 500,
            temperature: 0.7
        });

        const botResponse = response.choices[0].message.content;

        // Добавляем ответ бота
        conversation.messages.push({ role: 'assistant', content: botResponse, timestamp });

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
        }

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

        const reportMessage = `📊 ЕЖЕДНЕВНЫЙ ОТЧЕТ
📅 Дата: ${today}
💬 Проведено диалогов: ${stats.totalConversations}
✅ Заинтересовалось: ${stats.successfulConversations} человек
📈 Конверсия: ${conversionRate}%

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

app.get('/stats', (req, res) => {
    res.json({
        dailyStats: database.dailyStats,
        totalConversations: database.conversations.size,
        successfulCases: database.successfulCases.length
    });
});

// Запуск сервера
app.listen(config.port, () => {
    console.log(`Сервер запущен на порту ${config.port}`);
    console.log('Telegram бот активен!');
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
