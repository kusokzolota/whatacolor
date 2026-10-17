# whatacolor

Пипетка реального мира: наводишь камеру телефона — и видишь образное название цвета и его HEX, всё прямо в браузере, без сервера.

## Запуск

```bash
npm install
npm run dev
```

Dev-сервер работает по HTTPS с самоподписанным сертификатом (иначе камера не включится на телефоне в локальной сети).

## Сборка

```bash
npm run build
npm run preview
```

Готовый сайт — в папке `dist`. Для Cloudflare Pages: команда сборки `npm run build`, папка `dist`.

## Данные

Подсказка «Похожие краски» использует приближения цветов RAL Classic из статьи Wikipedia
[List of RAL colours](https://en.wikipedia.org/wiki/List_of_RAL_colours) (колонка CIELAB),
лицензия [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/); файл `src/ral.ts` распространяется на тех же условиях.
RAL — товарный знак RAL gGmbH. Значения приблизительные: для покупки краски сверяйтесь с официальным веером RAL.
