import concurrent.futures
import hashlib
import hmac
import io
import json
import pathlib
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from unittest.mock import patch
from faq_bot import Bot, Rejected, handler

SECRET = 'synthetic-app-secret'


def event(mid='demo-1', text='hours', sender='6500000000', kind='text', phone='DEMO_PHONE'):
    return {'object': 'whatsapp_business_account', 'entry': [{'changes': [
        {'field': 'messages', 'value': {'metadata': {'phone_number_id': phone},
         'messages': [{'id': mid, 'from': sender, 'type': kind, 'text': {'body': text}}]}}
    ]}]}


def signed(data):
    raw = json.dumps(data, ensure_ascii=False).encode()
    signature = 'sha256=' + hmac.new(SECRET.encode(), raw, hashlib.sha256).hexdigest()
    return raw, signature


class BotTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = pathlib.Path(self.temp.name) / 'test.sqlite3'
        self.bot = Bot(self.path, SECRET, 'DEMO_PHONE', 'synthetic-verify')

    def tearDown(self):
        self.temp.cleanup()

    def ingest(self, *args, **kwargs):
        return self.bot.ingest(*signed(event(*args, **kwargs)))

    def test_verification_challenge_and_wrong_token(self):
        self.assertEqual(self.bot.challenge('hub.mode=subscribe&hub.verify_token=synthetic-verify&hub.challenge=12345'), '12345')
        with self.assertRaises(Rejected):
            self.bot.challenge('hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345')

    def test_tampered_or_unsigned_payload_has_no_side_effects(self):
        raw, signature = signed(event())
        for body, sig in ((raw, ''), (raw + b' ', signature), (raw, 'sha256=bad')):
            with self.assertRaises(Rejected):
                self.bot.ingest(body, sig)
        self.assertEqual(self.bot.snapshot()['inbox'], [])

    def test_exact_faq_and_persistent_duplicate_guard(self):
        self.assertEqual(self.ingest()['accepted'], 1)
        restarted = Bot(self.path, SECRET, 'DEMO_PHONE', 'synthetic-verify')
        self.assertEqual(restarted.ingest(*signed(event()))['accepted'], 0)
        self.assertEqual(len(restarted.snapshot()['outbox']), 1)

    def test_concurrent_duplicate_deliveries_create_one_reply(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: self.ingest(), range(16)))
        self.assertEqual(sum(r['accepted'] for r in results), 1)
        self.assertEqual(len(self.bot.snapshot()['outbox']), 1)

    def test_stop_cancels_queued_reply_and_start_resumes(self):
        self.ingest('q1', 'hours')
        self.ingest('s1', 'STOP')
        self.ingest('q2', 'hours')
        rows = self.bot.snapshot()['outbox']
        self.assertEqual([r[3] for r in rows], ['cancelled', 'pending'])
        self.ingest('r1', 'START')
        self.ingest('q3', 'hours')
        self.assertEqual(len(self.bot.snapshot()['outbox']), 4)

    def test_unknown_question_flags_human_and_silences_bot(self):
        self.ingest('a1', 'Can you book me tomorrow?')
        self.ingest('a2', 'hours')
        self.assertEqual(len(self.bot.snapshot()['handoffs']), 1)
        self.assertEqual(len(self.bot.snapshot()['outbox']), 1)
        self.assertEqual(self.bot.snapshot()['contacts'][0][1], 'human')

    def test_unsupported_media_hands_off_without_guessing(self):
        self.ingest(kind='image', text='')
        self.assertEqual(len(self.bot.snapshot()['handoffs']), 1)

    def test_status_notifications_do_not_trigger_reply(self):
        data = event()
        value = data['entry'][0]['changes'][0]['value']
        value.pop('messages')
        value['statuses'] = [{'status': 'delivered', 'id': 'synthetic-status'}]
        self.assertEqual(self.bot.ingest(*signed(data)), {'accepted': 0})
        self.assertEqual(self.bot.snapshot()['outbox'], [])

    def test_wrong_destination_and_malformed_event_rejected(self):
        for data in (event(phone='ANOTHER_PHONE'), [], {'object': 'whatsapp_business_account', 'entry': None}):
            with self.assertRaises(Rejected):
                self.bot.ingest(*signed(data))

    def test_conflicting_id_rolls_back_whole_batch(self):
        self.ingest('id1', 'hours')
        data = event('id2', 'pricing')
        data['entry'][0]['changes'][0]['value']['messages'].append(
            event('id1', 'location')['entry'][0]['changes'][0]['value']['messages'][0])
        with self.assertRaises(Rejected):
            self.bot.ingest(*signed(data))
        self.assertEqual(len(self.bot.snapshot()['inbox']), 1)

    def test_successful_send_records_receipt(self):
        self.ingest()
        with patch('urllib.request.urlopen', return_value=io.BytesIO(b'{"messages":[{"id":"synthetic-receipt"}]}')) as send:
            self.assertEqual(self.bot.send_one('synthetic-access', 'v99.0'), 'sent')
            request = send.call_args.args[0]
            self.assertEqual(json.loads(request.data)['to'], '6500000000')
        self.assertEqual(self.bot.snapshot()['outbox'][0][-1], 'synthetic-receipt')

    def test_network_timeout_is_not_automatically_retried(self):
        self.ingest()
        with patch('urllib.request.urlopen', side_effect=TimeoutError) as send:
            self.assertEqual(self.bot.send_one('synthetic-access', 'v99.0'), 'uncertain')
            self.assertEqual(self.bot.send_one('synthetic-access', 'v99.0'), 'empty')
            self.assertEqual(send.call_count, 1)

    def test_rate_limit_stays_pending(self):
        self.ingest()
        error = urllib.error.HTTPError('https://example.invalid', 429, 'rate limited', {}, None)
        with patch('urllib.request.urlopen', side_effect=error):
            self.assertEqual(self.bot.send_one('synthetic-access', 'v99.0'), 'pending')

    def test_invalid_token_is_failed_and_not_retried(self):
        self.ingest()
        error = urllib.error.HTTPError('https://example.invalid', 401, 'unauthorized', {}, None)
        with patch('urllib.request.urlopen', side_effect=error) as send:
            self.assertEqual(self.bot.send_one('synthetic-access', 'v99.0'), 'failed')
            self.assertEqual(self.bot.send_one('synthetic-access', 'v99.0'), 'empty')
            self.assertEqual(send.call_count, 1)

    def test_live_sender_requires_explicit_configuration(self):
        with self.assertRaises(ValueError):
            self.bot.send_one('', 'v99.0')

    def test_http_challenge_signed_post_and_bad_signature(self):
        server = ThreadingHTTPServer(('127.0.0.1', 0), handler(self.bot))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f'http://127.0.0.1:{server.server_port}/webhook'
        try:
            with urllib.request.urlopen(base + '?hub.mode=subscribe&hub.verify_token=synthetic-verify&hub.challenge=42') as response:
                self.assertEqual(response.read(), b'42')
            raw, signature = signed(event())
            request = urllib.request.Request(base, data=raw, headers={'X-Hub-Signature-256': signature})
            with urllib.request.urlopen(request) as response:
                self.assertEqual(json.load(response)['accepted'], 1)
            with self.assertRaises(urllib.error.HTTPError):
                urllib.request.urlopen(urllib.request.Request(base, data=raw))
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == '__main__':
    unittest.main(verbosity=2)
