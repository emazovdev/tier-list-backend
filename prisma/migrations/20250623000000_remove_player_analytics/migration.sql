-- Удаляем ограничение внешнего ключа, связанное с player_analytics
ALTER TABLE IF EXISTS player_analytics DROP CONSTRAINT IF EXISTS player_analytics_telegram_id_fkey;

-- Удаляем таблицу player_analytics
DROP TABLE IF EXISTS player_analytics; 