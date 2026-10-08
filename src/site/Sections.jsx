import { INSTAGRAM, TELEGRAM, WHATSAPP } from "../lib/contacts.js";

const SERVICES = [
  {
    title: "Ролик для бренда",
    text: "Атмосфера компании, продукта или услуги. Чтобы за 10–20 секунд было понятно, кто вы.",
  },
  {
    title: "Личный образ",
    text: "Экспертный или чувственный визуал для блога, запуска, поздравления, личного бренда.",
  },
  {
    title: "Рекламный кадр",
    text: "Товар, акция, анонс. Коротко, ярко, так, чтобы хотелось досмотреть и написать.",
  },
  {
    title: "Контент для сети",
    text: "Reels, TikTok, Shorts. Вертикаль 9:16, ритм под музыку, хук в первые секунды.",
  },
];

const STEPS = [
  { title: "Задача", text: "Пишете, для кого ролик, какой вайб и куда его ставить." },
  { title: "Идея", text: "Предлагаю стиль, образы и короткий сценарий кадра." },
  { title: "Сборка", text: "Генерирую визуал, монтирую, подкладываю ритм и текст." },
  { title: "Правки", text: "Смотрите черновик. Доводим до финала вместе." },
];

export function Hero() {
  return (
    <section className="hero">
      <div className="hero-copy">
        <p className="eyebrow">AI Creator · ролики на заказ</p>
        <h1>Жанара</h1>
        <p className="lead">
          Собираю ИИ-видео, которые выглядят как короткий фильм: настроение, образ и смысл — под вашу
          задачу.
        </p>
        <div className="hero-actions">
          <a className="btn btn-gold" href="#shop">
            Заказать ролик
          </a>
          <a className="btn btn-ghost" href="#services">
            Что я делаю
          </a>
        </div>
        <dl className="hero-meta">
          <div>
            <dt>Форматы</dt>
            <dd>Reels · Shorts · реклама</dd>
          </div>
          <div>
            <dt>Старт</dt>
            <dd>веду каждый заказ лично</dd>
          </div>
        </dl>
      </div>

      <figure className="portrait">
        <img src="/img/zhanara.jpg" alt="Жанара — AI-креатор" width="1200" height="1500" />
        <figcaption>
          <span>Портрет</span>
          <strong>Жанара</strong>
        </figcaption>
      </figure>
    </section>
  );
}

export function About() {
  return (
    <section className="about" id="about">
      <p className="section-index">01 — знакомство</p>
      <div className="about-grid">
        <h2>
          Киноязык нейросетей.
          <br />С человеческим вкусом.
        </h2>
        <div className="about-text">
          <p>
            Меня зовут Жанара, мне 42. Я AI-креатор: придумываю визуал и собираю ролики с помощью
            нейросетей — на заказ.
          </p>
          <p>
            В ИИ-видео я недавно. Поэтому работаю без конвейера: сама слушаю задачу, собираю стиль и
            довожу картинку, пока она не станет «вашей».
          </p>
          <p>
            Если нужен ролик для бренда, эксперта, товара или просто сильный короткий кадр в соцсети —
            напишите. Сделаем.
          </p>
        </div>
      </div>
    </section>
  );
}

export function Services() {
  return (
    <section className="services" id="services">
      <p className="section-index">02 — услуги</p>
      <div className="section-head">
        <h2>Что можно заказать</h2>
        <p>Короткие ролики под задачу. Не шаблон из ленты — сцена, свет и характер.</p>
      </div>
      <div className="cards">
        {SERVICES.map((service, index) => (
          <article className="card" key={service.title}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <h3>{service.title}</h3>
            <p>{service.text}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

export function Process() {
  return (
    <section className="process" id="process">
      <p className="section-index">03 — процесс</p>
      <div className="section-head">
        <h2>Как это происходит</h2>
        <p>Четыре шага. Без лишней бюрократии — вы говорите, я собираю картинку.</p>
      </div>
      <ol className="steps">
        {STEPS.map((step) => (
          <li key={step.title}>
            <h3>{step.title}</h3>
            <p>{step.text}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function Contact() {
  return (
    <section className="contact" id="contact">
      <p className="section-index">05 — связь</p>
      <div className="contact-box">
        <h2>Давайте сделаем ваш ролик</h2>
        <p>Напишите в Telegram или WhatsApp: задачу, референс, если есть, и срок. Отвечаю лично.</p>
        <div className="contact-actions">
          <a className="btn btn-gold" href={TELEGRAM} target="_blank" rel="noopener noreferrer">
            Telegram
          </a>
          <a className="btn btn-ghost" href={WHATSAPP} target="_blank" rel="noopener noreferrer">
            WhatsApp
          </a>
          <a className="btn btn-ghost" href={INSTAGRAM} target="_blank" rel="noopener noreferrer">
            Instagram
          </a>
        </div>
      </div>
    </section>
  );
}

export function Footer() {
  return (
    <footer className="footer">
      <p>Жанара · AI Creator</p>
      <p>ИИ-ролики на заказ · 2026</p>
    </footer>
  );
}
