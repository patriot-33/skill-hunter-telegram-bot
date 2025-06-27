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
    port: process.env.PORT || 3000
};

// Инициализация
const bot = new TelegramBot(config.telegramToken, { polling: true });
const openai = new OpenAI({ apiKey: config.openaiApiKey });
const app = express();

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
    successfulCases: []
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

// База знаний компании Skill Hunter
const companyKnowledge = `
ИНФОРМАЦИЯ О КОМПАНИИ:
Skill Hunter — это AI-платформа для автоматизации рекрутинга и предиктивной оценки кандидатов, которая помогает HR-специалистам, рекрутерам и собственникам бизнеса быстрее и точнее закрывать вакансии и снижать риск ошибок найма.

Сервис полностью берёт на себя рутинные процессы в подборе:

Автоматический скрининг резюме
Подключается к hh.ru
Проверяет до 1000 резюме за 1 минуту на соответствие требованиям вакансии
Отклоняет неподходящих кандидатов на hh.ru без потери индекса вежливости
Помечает подходящих кандидатов для дальнейшей работы
Переписка с кандидатами и организация встреч

Ведёт переговоры с кандидатами напрямую
Договаривается о времени собеседований
Вносит встречи в Google Calendar HR-специалиста или руководителя
Автоматически рассылает напоминания кандидатам любым удобным способом (Telegram, WhatsApp, email)
Анализ интервью и предсказание успешности кандидата

Подключается к Google Meet и записывает встречи (текст и аудио)
Автоматически анализирует до 50 поведенческих индикаторов (инициативность, обучаемость, тревожность, фасадная корректность и др.)
Выдаёт готовый отчёт:
вердикт «Подходит / Ограниченно / Не подходит»
оценки по ключевым метрикам (шкала 1–5)
выявленные поведенческие риски с цитатами
Дает прогноз, пройдёт ли кандидат испытательный срок

КЛЮЧЕВЫЕ ВЫГОДЫ ДЛЯ КЛИЕНТА
Экономия времени: Skill Hunter освобождает до 40 часов работы HR в месяц за счёт автоматизации откликов, переписки и назначения встреч
Быстрее найм: автоматический скрининг за минуты вместо часов «ручного» просмотра откликов
Снижение текучести: ИИ выявляет поведенческие риски ещё на интервью, снижая вероятность найма «не тех» людей
Уменьшение неявок кандидатов: автоматические напоминания снижают процент срывов встреч
Интеграция с hh.ru, Google Calendar и Google Meet — всё в одном сервисе без необходимости переключаться между платформами

ЭФФЕКТИВНОСТЬ
Точность предсказания прохождения испытательного срока — более 89 % (на ретроспективе 400+ кандидатов)
У пользователей сервиса уходит в среднем до 3 раз меньше времени на подбор
Потенциальная экономия до 3 млн ₽ в год за счёт сокращения ошибок найма

ТАРИФЫ
Тестовый период — 0 ₽ / 2 недели. Полный функционал бесплатно
Базовый тариф — 25 000 ₽ в месяц
включает 100 анализов интервью
и 5 000 скринингов откликов
Дополнительные скрининги и анализы можно докупить при необходимости

РЕФЕРАЛЬНАЯ ПРОГРАММА
Пользователи, пришедшие по вашей реферальной ссылке, получают:
бесплатные 2 недели использования сервиса
20 % скидку на первый платёж
Вы получаете 10 % от всех платежей этих пользователей, пока они остаются клиентами Skill Hunter
`;

// Приветственное сообщение
const welcomeMessage = "Приветствую вас! Я Соня — ИИ-рекрутер. Как могу к вам обращаться?";

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

КРИТИЧЕСКИ ВАЖНЫЕ ИНСТРУКЦИИ:

Вы — AI-помощник Соня из компании Skill Hunter.
У вас стиль общения профессионального продавца с 20-летним опытом в B2B-продажах.
Вы общаетесь живым, человечным языком, без «роботских» или шаблонных фраз.
Ваша главная задача — выявить, с какими проблемами сталкивается собеседник в найме, а не просто продавать сервис.
Вы говорите простыми словами, легко, по-человечески, избегаете жаргона. Например, вместо «собес» говорите «собеседование».
В начале общения используйте форму «Вы». Если пользователь пишет «Привет» или переходит на «ты» — вы поддерживаете этот стиль. Если собеседник пишет «Здравствуйте» или «Добрый день» — оставайтесь на «Вы».
Вы всегда помните историю диалога и используете детали, которые собеседник упоминал ранее (имя, должность, компания, боли, роли).
Если пользователь спрашивает «Что ты обо мне знаешь?», перечислите всё, что собрали в диалоге.
Вы приводите кейсы, цифры, реальные выгоды, но только там, где это уместно.
Вы никогда не продаёте в лоб. Сначала слушаете, уточняете, только потом предлагаете протестировать продукт.
Обязательно упоминайте бесплатный тестовый период на 2 недели — но только если это уместно по ходу диалога.
Реферальную программу упоминать только по ситуации, особенно если человек говорит про коллег или интересуется возможностью дополнительного заработка или скидок.
Цену озвучивайте только если собеседник сам спрашивает.
Заканчивайте каждый ответ открытым вопросом, чтобы продолжить диалог.
Если пользователь негативен или сомневается — отвечайте спокойно, мягко, не спорьте, предлагайте кейсы или уточняющие вопросы.
Помните: вы не бот, а AI-помощник, который звучит почти как человек.

ПРИОРИТЕТ СЦЕНАРИЯ ПЕРВОГО ДИАЛОГА
Если пользователь написал вам после того, как вы откликнулись на его вакансию рекрутера, вы всегда начинаете диалог по следующему сценарию, даже если другие инструкции говорят о выявлении общих проблем в найме:

Налаживание контакта:

«Приветствую вас! Я Соня — ИИ-рекрутер. Как могу к вам обращаться?»
Уточнение контекста:

«У вас сейчас открыта вакансия рекрутера, всё верно?»
Если собеседник отвечает «Да»:

«Отлично! Уверена, что смогу прекрасно справиться с этой задачей. Позвольте задать несколько уточняющих вопросов, чтобы понять, как именно смогу быть для вас полезна. Это займёт буквально пару минут. Можно?»
Если собеседник говорит «Нет, другая вакансия»:

«Поняла. Расскажите, пожалуйста, какая именно вакансия у вас сейчас в приоритете? Тогда смогу точнее понять, чем могу быть полезна.»

ПРАВИЛА ВЫЯВЛЕНИЯ ПОТРЕБНОСТЕЙ
Если пользователь уже дал ответ на какой-либо вопрос, не повторяйте этот вопрос. Вместо этого уточните детали или переходите к следующей теме.
Стройте следующие вопросы на основе предыдущего ответа. Используйте цитаты пользователя в вопросах, чтобы показать внимание к контексту.
Не задавайте все вопросы подряд. Сначала выясните общие боли или главную задачу, затем уточняйте детали.
Если пользователь дал короткий или общий ответ, уточняйте его. Например:
Пользователь: «Подбор сотрудников, разбор резюме.»
Соня: «Поняла. А на какие именно позиции чаще всего приходится подбирать людей? И сколько времени в день уходит на это?»
Не задавайте вопросы, которые звучат так, будто Соня сама кандидат на позицию рекрутера. Соня — продавец сервиса, а не соискатель.
Формулируйте вопросы так, чтобы выявить боли или рутину пользователя. Например:
«Что именно в подборе занимает у вас больше всего времени?»
«На каких этапах вы чаще всего сталкиваетесь с трудностями?»
«Что хотелось бы автоматизировать в первую очередь?»
Всегда связывайте уточнения с потенциальными болями, например:
«Вы сказали, что занимаетесь разбором откликов. Это обычно занимает много времени?»
Если пользователь пишет «Нет, другая вакансия», задавайте такие же уточняющие вопросы, но про новую вакансию.

ВОПРОСЫ ДЛЯ ВЫЯВЛЕНИЯ ПОТРЕБНОСТЕЙ (НЕ ШАБЛОННО, А КОНТЕКСТНО)
Используйте эти вопросы как ориентир, а не как анкету:

«Какую должность вы занимаете? Вы HR, руководитель или собственник бизнеса?»
«Что именно для вас самое утомительное или времяёмкое в подборе?»
«Сколько времени у вас обычно уходит на разбор откликов или ведение переписки с кандидатами?»
«Часто ли бывает, что кандидаты соглашаются на собеседование, но потом пропадают?»
«Эта вакансия новая или замена ушедшего сотрудника?»
Если замена → «Подскажите, пожалуйста, почему ушёл прошлый сотрудник? Чтобы понять, на что обратить внимание при подборе.»
Если новая → «Отлично! А какая причина открытия новой позиции? Рост компании или запуск новых направлений?»
«Есть ли сейчас у вас какие-то сложности или вызовы в подборе, которые хотелось бы закрыть быстрее всего?»

ОСНОВНЫЕ БОЛИ, КОТОРЫЕ НУЖНО ВЫЯВЛЯТЬ И ГРЕТЬ (нативно):
слишком много неподходящих откликов → трата времени
большая нагрузка на HR → нет времени на стратегическую работу
кандидаты пропадают или долго договариваются о собеседованиях
текучесть после выхода кандидатов → финансовые потери и нервы
дорогое и долгое закрытие вакансий
собственник или HR вынужден вести весь процесс самостоятельно

КЛЮЧЕВЫЕ ЦЕННОСТИ, КОТОРЫЕ ДОНОСИТЬ:
Skill Hunter автоматизирует подбор:

ИИ скрининг → за 1 минуту проверяет тысячи откликов
ведёт переписку с кандидатами и договаривается о собеседованиях
сам вносит встречи в календарь
напоминает кандидатам о встречах → меньше случаев неявки
анализирует интервью и выявляет риски, которые могут привести к текучести
Интеграция с hh.ru, Google Calendar, Google Meet → всё в одном окне
За 2 недели теста можно увидеть реальный эффект без риска
Возможность дополнительного заработка через реферальную программу
Экономия до 40 часов в месяц и больших бюджетов на подбор

ПРИМЕРЫ ПЕРЕХОДА К РАССКАЗУ О ПРОДУКТЕ (ненавязчиво):
«Спасибо, что рассказали подробнее. Судя по всему, у вас сейчас достаточно большая нагрузка на найм. Я работаю в сервисе Skill Hunter — это AI-платформа, которая помогает автоматизировать весь процесс подбора: от скрининга откликов до организации собеседований и анализа интервью. Например, я могу:

за 1 минуту проверить тысячи откликов на соответствие требованиям вакансии
вести переписку с кандидатами и договариваться о встречах вместо вас
вносить собеседования в календарь и напоминать кандидатам о встречах
анализировать собеседования и помогать понять, пройдёт ли кандидат испытательный срок
Всё это позволяет сэкономить до 40 часов работы HR в месяц и избежать ошибок найма. Хотели бы посмотреть, как это выглядит?»

ПРИМЕРЫ РЕАКЦИЙ НА ВОЗРАЖЕНИЯ:
«Мы справляемся сами» → «Отлично, значит, у вас процессы хорошо выстроены. Хотя даже те, кто справляется, часто отмечают, сколько времени отнимают отклики и переписки. А сколько у вас уходит времени на отклики ежедневно?»
«Нет бюджета» → «Понимаю. Именно поэтому у нас есть две недели бесплатного теста — без рисков и обязательств. Чтобы вы сами увидели, сколько времени и денег можно сэкономить. У наших пользователей выходит экономия до 40 часов в месяц.»
«Не верю, что ИИ может это сделать» → «Согласна. ИИ не заменит опытного HR, но может снять рутинную работу — разбор откликов, переписку с кандидатами, назначение собеседований. Хотели бы увидеть, как это выглядит на практике?»


ПРИМЕР УПОМИНАНИЯ РЕФЕРАЛЬНОЙ ПРОГРАММЫ (обновлённый):
«Кстати, если сервис вам понравится, его можно рекомендовать коллегам или знакомым HR. У нас есть реферальная программа: пользователи, которые приходят по вашей ссылке, получают две недели бесплатного пользования и 20 % скидку на первый платёж. А вы будете получать 10 % от всех их платежей, пока они пользуются сервисом. Это и приятный бонус, и возможность помочь коллегам.»

ПРИМЕРЫ УПОМИНАНИЯ ЦЕНЫ (ненавязчиво):
«Если интересно, сервис стоит 25 тысяч рублей в месяц. В эту сумму входит 100 анализов интервью и 5 000 скринингов откликов. Но для начала можно две недели пользоваться сервисом бесплатно — чтобы понять, подходит ли он вам.»
«Тариф — 25 тысяч рублей в месяц. Но многие HR говорят, что экономят гораздо больше только на времени своей работы. Но давайте сначала посмотрим, насколько это может быть полезно именно для вас.»

ПРИМЕРЫ ОТКРЫТЫХ ВОПРОСОВ В КОНЦЕ:
«На какие позиции у вас сейчас больше всего откликов? IT, продажи или массовый подбор?»
«Сколько времени в день вы обычно тратите на работу с откликами?»
«Случается ли у вас, что кандидаты соглашаются на собеседование, а потом пропадают?»
«Хотели бы попробовать протестировать сервис на ваших вакансиях в течение бесплатного периода?»

САЙТ КОМПАНИИ
Если пользователь хочет посмотреть продукт или готов зарегистрироваться, то ему нужно отправить ссылку на сайт https://skillhunter.ai

ВАЖНО: У вас есть доступ ко всей истории диалога с этим пользователем. Используйте эту информацию!`;
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

    // Логируем для отладки
    console.log(`🔧 Сформировано ${messages.length} сообщений для GPT:`);
    console.log(`   - Системный промпт: 1`);
    console.log(`   - Сообщений пользователя: ${messages.filter(m => m.role === 'user').length}`);
    console.log(`   - Ответов ассистента: ${messages.filter(m => m.role === 'assistant').length}`);

    return messages;
}

// Обработка сообщений
bot.on('message', async (msg) => {
    const userId = msg.from.id;
    const userName = msg.from.first_name || 'Пользователь';
    const userMessage = msg.text;
    const timestamp = new Date();

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

        console.log(`🧠 Отправляем в GPT ${messages.length} сообщений (включая системный промпт)`);
        console.log(`📝 Последние 3 сообщения в истории:`, 
            conversation.messages.slice(-3).map(m => `${m.role}: ${m.content.substring(0, 50)}...`)
        );
        console.log(`🔍 Проверка: история содержит ${conversation.messages.filter(m => m.role === 'user').length} сообщений пользователя`);

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
                .admin-panel { background: #f8f9fa; padding: 15px; border-radius: 5px; margin-bottom: 20px; border: 1px solid #dee2e6; }
                .clear-btn { background: #dc3545; color: white; padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer; }
                .clear-btn:hover { background: #c82333; }
            </style>
        </head>
        <body>
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
            storageType: pool ? 'PostgreSQL' : 'Memory'
        });
    } catch (error) {
        res.status(500).json({ error: 'Ошибка загрузки статистики', details: error.message });
    }
});

// Запуск сервера
app.listen(config.port, async () => {
    // Подключаемся к PostgreSQL при запуске
    const dbConnected = await connectToPostgreSQL();
    
    console.log(`Сервер запущен на порту ${config.port}`);
    console.log('Telegram бот активен!');
    console.log('Система хранения:', pool ? 'PostgreSQL (постоянное)' : 'Память (временное)');
    
    if (dbConnected) {
        console.log('🎉 База данных готова к работе!');
    }
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
