# Threads: стейт на момент ребута мака (21.08.2026)

## Что выяснено (не переделывать)
1. Save в консоли Меты (Redirect Callback URLs) НЕВОЗМОЖЕН: эндпоинт
   POST /apps/1080592121075910/async/threads-login/setting/save/?th_app_id=1051196250851086
   отвечает 404 (HTML not found) при ЛЮБОМ пейлоаде. Это баг Меты, не форма.
   Чипс/телефон/пустые поля - не при чём. OAuth-путь через redirect ЗАБЛОКИРОВАН.
2. Рабочий путь: User Token Generator на той же странице настроек
   (apps/1080592121075910/use_cases/customize/settings/?use_case_enum=THREADS_API).
   Тестер neironka.pro в таблице есть, кнопка Generate Access Token кликается моим CDP.
   Кнопка открывает попап threads.com/oauth/authorize (response_type=code,
   redirect=developers.facebook.com/threads/token_generator/oauth/).
3. Ошибка 1349245 "user has not accepted invite" = активный ВЕБ-профиль threads.com
   сейчас tony007ai (Антон), а тестер - neironka.pro. Свитчера профилей в вебе НЕТ
   (меню More: только Appearance/Settings/Liked/Archive/Report/Log out).

## План после ребута
1. Открыть threads.com в моей вкладке -> Log out (выход из tony007ai).
2. Залогиниться через Instagram-креды бренд-акка neironka.pro (доступ разрешён,
   память neironka-standing-account-access). Креды искать в панели/БД yt_channels/
   аккаунтах фермы (brand-акк), либо спросить начальника.
3. После логина: threads.com/settings/website_permissions -> вкладка Invites ->
   принять инвайт тестера "Neironka Poster".
4. Вернуться в консоль Меты -> Generate Access Token у neironka.pro -> попап Allow.
   Попап блокируется - хук window.open уже отработал; можно открыть URL из __pop
   в новой вкладке, но лучше дать попапу открыться (клик работает).
5. Токен положить в БД: update yt_channels set auth=jsonb auth||{'access_token':...,
   'user_id':..., 'expires_at':...} where slug='threads_neironka' (формат как в src/threads.ts).
   Либо обменять код по th_exchange_token - см. threads3.cjs loadTok.
6. Запустить: cd ~/Desktop/neironka-poster && nohup node threads3.cjs > /tmp/threads3.log 2>&1 &
   (3 поста с интервалом 3ч, фото уже в public/t/, ТГ-уведы встроены).

## После ребута также перезапустить
- ytrunner loop: cd ~/Desktop/neironka-poster && nohup node ytrunner.cjs loop > /tmp/ytrunner.log 2>&1 &
  (ровно ОДИН процесс, не плодить).
- Сторож обложек prigovor/podruga: node autothumb_wait.cjs (ждёт вериф каналов
  pFC5a5QCW10 и aAhLQPUK0qU, дольёт обложки).
- Проверить деплой редизайна вкладки YouTube на Railway (панель web-production-efed0).
