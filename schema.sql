-- ============================================================================
--  优选订阅 Worker · D1 建表脚本
--  用法：npx wrangler d1 execute sub-db --remote --file=schema.sql
--        （或在 Cloudflare 控制台 D1 的 SQL 编辑器里整段执行）
-- ============================================================================

CREATE TABLE IF NOT EXISTS ips (
  id       INTEGER PRIMARY KEY,          -- 主键；后台「按地区排序」会重排此列
  ip       TEXT    NOT NULL UNIQUE,      -- 形如 104.16.2.3:443 / [2606:4700::1]:443
                                         -- UNIQUE 是 INSERT OR IGNORE 去重的前提
  name     TEXT,                         -- 备注，如「香港优选」，也用于地区识别与排序
  active   INTEGER NOT NULL DEFAULT 1,   -- 1 启用 / 0 禁用；订阅只取启用项
  priority INTEGER NOT NULL DEFAULT 0    -- 权重，越小越靠前
);

-- 订阅查询的主索引：WHERE active=1 ORDER BY priority, id
CREATE INDEX IF NOT EXISTS idx_ips_active_priority ON ips(active, priority);
