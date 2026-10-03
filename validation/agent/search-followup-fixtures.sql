-- Isolated QA only. Do not import into 8182. No external URLs or collection jobs.
insert into sources(id, platform, name, enabled) values
('qa-followup', 'rss', '隔离验收材料', false) on conflict do nothing;
insert into items(id, source_id, platform, external_id, title, body, media_type, published_at)
values
('qa-long', 'qa-followup', 'rss', repeat('long_external_', 150), '长正文与尾部证据', repeat('隔离长正文。', 4000) || 'TAIL-973：返工率3%。', 'article', '2026-09-11T04:00:00Z'),
('qa-empty', 'qa-followup', 'rss', 'empty', '空正文', '', 'article', '2026-09-11T04:00:00Z'),
('qa-pending', 'qa-followup', 'rss', 'pending', '待OCR', '图片占位文字，尚未完成提取。', 'image', '2026-09-11T04:00:00Z'),
('qa-before', 'qa-followup', 'rss', 'before', '上海日界前', '范围外材料', 'article', '2026-09-10T15:59:59.999Z'),
('qa-start', 'qa-followup', 'rss', 'start', '上海日界起点', '应纳入材料', 'article', '2026-09-10T16:00:00Z'),
('qa-last', 'qa-followup', 'rss', 'last', '上海日界末毫秒', '应纳入材料', 'article', '2026-09-11T15:59:59.999Z'),
('qa-end', 'qa-followup', 'rss', 'end', '上海下一日起点', '范围外材料', 'article', '2026-09-11T16:00:00Z'),
('qa-change', 'qa-followup', 'rss', 'change', '材料修订样本', '原始结论：良率97%。', 'article', '2026-09-11T04:00:00Z')
on conflict do nothing;
insert into extract_jobs(id,item_id,kind,status)
values('qa-ocr', 'qa-pending', 'ocr', 'pending') on conflict do nothing;
