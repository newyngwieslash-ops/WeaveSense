import assert from 'node:assert/strict';
import test from 'node:test';
import { stripHtml } from '../format.ts';
import { parseTelegramHtml } from './telegram.ts';

test('HTML cleaning decodes numeric entities after stripping tags and styles', () => {
  assert.equal(stripHtml('<style>.bad{color:red}</style><p>&#036;2,222,000&#33;</p><div>&#x1F3C6; &lt;value&gt; &amp;</div>'), '$2,222,000!\n🏆 <value> &');
});
test('Telegram emoji backgrounds are not message photographs', () => {
  const base = '<div class="tgme_widget_message " data-post="durov/547"><div class="tgme_widget_message_text"><i style="background-image:url(emoji.webp)"></i>&#036;222&#33;</div>';
  const [text] = parseTelegramHtml(base, 'durov');
  assert.equal(text.body, '$222!'); assert.equal(text.thumbnail_url, ''); assert.deepEqual(text.media_urls, []);
  const [photo] = parseTelegramHtml(base + '<a class="tgme_widget_message_photo_wrap" style="background-image:url(\'photo.jpg\')"></a>', 'durov');
  assert.equal(photo.thumbnail_url, 'photo.jpg');
});
