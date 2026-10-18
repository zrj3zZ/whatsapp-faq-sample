"""Offline-testable WhatsApp FAQ webhook. Python 3.10+, standard library only."""
import argparse
import contextlib
import hashlib
import hmac
import json
import os
import re
import sqlite3
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

FAQ = {
    'hours': 'Demo business hours: Monday-Friday, 09:00-18:00 Singapore time.',
    'pricing': 'This demo does not invent prices. A team member can prepare a quote.',
    'location': 'Demo service area: Singapore. Ask the team to confirm availability.',
}


class Rejected(ValueError):
    pass


class Bot:
    def __init__(self, database, secret, phone_id, verify_token):
        if not all((secret, phone_id, verify_token)):
            raise ValueError('App secret, phone ID and verification token are required')
        self.database, self.secret = str(database), secret.encode()
        self.phone_id, self.verify_token = phone_id, verify_token
        with self.connect() as db:
            db.executescript('''
              CREATE TABLE IF NOT EXISTS inbox (
                id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL);
              CREATE TABLE IF NOT EXISTS contacts (
                sender TEXT PRIMARY KEY, mode TEXT NOT NULL);
              CREATE TABLE IF NOT EXISTS outbox (
                id TEXT PRIMARY KEY, sender TEXT NOT NULL, body TEXT NOT NULL,
                state TEXT NOT NULL DEFAULT 'pending', receipt TEXT);
              CREATE TABLE IF NOT EXISTS handoffs (
                id TEXT PRIMARY KEY, sender TEXT NOT NULL, reason TEXT NOT NULL);
            ''')

    @contextlib.contextmanager
    def connect(self):
        db = sqlite3.connect(self.database, timeout=10)
        try:
            with db:
                yield db
        finally:
            db.close()

    def challenge(self, query):
        values = urllib.parse.parse_qs(query)
        token = values.get('hub.verify_token', [''])[0]
        challenge = values.get('hub.challenge', [''])[0]
        if (values.get('hub.mode') == ['subscribe'] and challenge
                and hmac.compare_digest(token, self.verify_token)):
            return challenge
        raise Rejected('Verification failed')

    def ingest(self, raw, signature):
        expected = 'sha256=' + hmac.new(self.secret, raw, hashlib.sha256).hexdigest()
        if not isinstance(signature, str) or not hmac.compare_digest(expected, signature):
            raise Rejected('Signature failed')
        try:
            event = json.loads(raw)
            if not isinstance(event, dict) or event.get('object') != 'whatsapp_business_account':
                raise Rejected('Unsupported event')
            messages = []
            for entry in event.get('entry', []):
                for change in entry.get('changes', []):
                    if change.get('field') != 'messages':
                        continue
                    value = change['value']
                    if value.get('metadata', {}).get('phone_number_id') != self.phone_id:
                        raise Rejected('Wrong destination')
                    for message in value.get('messages', []):
                        mid, sender = message['id'], message['from']
                        if (not isinstance(mid, str) or not 0 < len(mid) <= 256
                                or not isinstance(sender, str)
                                or re.fullmatch(r'[0-9]{5,20}', sender) is None):
                            raise Rejected('Invalid message identifiers')
                        text = message.get('text', {}).get('body', '')
                        if not isinstance(text, str):
                            raise Rejected('Invalid text')
                        messages.append((mid, sender, message.get('type'), text))
        except (ValueError, KeyError, TypeError, AttributeError) as exc:
            raise Rejected('Invalid event') from exc
        accepted = 0
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            for mid, sender, kind, text in messages:
                fingerprint = hashlib.sha256(json.dumps(
                    [sender, kind, text], ensure_ascii=False).encode()).hexdigest()
                old = db.execute('SELECT fingerprint FROM inbox WHERE id=?', (mid,)).fetchone()
                if old:
                    if old[0] != fingerprint:
                        raise Rejected('Conflicting message ID')
                    continue
                db.execute('INSERT INTO inbox VALUES (?,?)', (mid, fingerprint))
                accepted += 1
                command = ' '.join(text.casefold().split())
                row = db.execute('SELECT mode FROM contacts WHERE sender=?', (sender,)).fetchone()
                mode = row[0] if row else 'active'
                reply = None
                if command == 'stop':
                    mode = 'stopped'
                    # Cancel messages not yet dispatched before confirming STOP.
                    db.execute("UPDATE outbox SET state='cancelled' WHERE sender=? AND state='pending'", (sender,))
                    reply = 'Automated replies are stopped. Send START to resume.'
                elif command == 'start':
                    mode, reply = 'active', 'Automated replies resumed. Ask: hours, pricing or location.'
                elif mode in ('stopped', 'human'):
                    pass
                elif kind == 'text' and command in FAQ:
                    reply = FAQ[command]
                else:
                    mode = 'human'
                    db.execute('INSERT INTO handoffs VALUES (?,?,?)', (mid, sender, 'Unknown question or unsupported message'))
                    reply = 'I have flagged this conversation for the team. Automated replies are paused; send START to resume.'
                db.execute('INSERT OR REPLACE INTO contacts VALUES (?,?)', (sender, mode))
                if reply:
                    db.execute('INSERT INTO outbox(id,sender,body) VALUES (?,?,?)', (mid, sender, reply))
        return {'accepted': accepted}

    def snapshot(self):
        """Local diagnostic only; never exposed as a public HTTP endpoint."""
        with self.connect() as db:
            return {table: db.execute('SELECT * FROM ' + table).fetchall()
                    for table in ('inbox', 'contacts', 'outbox', 'handoffs')}

    def send_one(self, token, version):
        """Explicit live delivery. Ambiguous failures are held for human reconciliation."""
        if not token or re.fullmatch(r'v[0-9]+\.0', version or '') is None:
            raise ValueError('Explicit access token and Graph version required')
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute("SELECT id,sender,body FROM outbox WHERE state='pending' ORDER BY rowid LIMIT 1").fetchone()
            if not row:
                return 'empty'
            mid, sender, body = row
            # Persist before network I/O: after a crash this must not auto-resend.
            db.execute("UPDATE outbox SET state='uncertain' WHERE id=?", (mid,))
        payload = json.dumps({'messaging_product': 'whatsapp', 'to': sender,
                              'type': 'text', 'text': {'body': body}}).encode()
        request = urllib.request.Request(
            f'https://graph.facebook.com/{version}/{self.phone_id}/messages',
            data=payload, headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
        state, receipt = 'uncertain', None
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                receipt = json.load(response)['messages'][0]['id']
            state = 'sent'
        except urllib.error.HTTPError as exc:
            # An explicit rate limit is retryable. Other rejections need correction.
            state = 'pending' if exc.code == 429 else ('failed' if 400 <= exc.code < 500 else 'uncertain')
        except (OSError, ValueError, KeyError, IndexError, TypeError):
            pass
        with self.connect() as db:
            db.execute('UPDATE outbox SET state=?,receipt=? WHERE id=?', (state, receipt, mid))
        return state


def handler(bot):
    class Handler(BaseHTTPRequestHandler):
        def respond(self, code, text):
            data = text.encode()
            self.send_response(code)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            parts = urllib.parse.urlsplit(self.path)
            if parts.path != '/webhook':
                self.respond(404, 'Not found')
                return
            try:
                self.respond(200, bot.challenge(parts.query))
            except Rejected:
                self.respond(403, 'Verification failed')

        def do_POST(self):
            if urllib.parse.urlsplit(self.path).path != '/webhook':
                self.respond(404, 'Not found')
                return
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= 262144:
                    self.respond(413, 'Invalid payload length')
                    return
                result = bot.ingest(self.rfile.read(size), self.headers.get('X-Hub-Signature-256', ''))
                self.respond(200, json.dumps(result))
            except (Rejected, ValueError):
                self.respond(400, 'Invalid webhook')

        def log_message(self, *args):
            pass  # Do not log query-string verification tokens or message contents.
    return Handler


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--database', default='faq.sqlite3')
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--send-one', action='store_true')
    args = parser.parse_args()
    bot = Bot(args.database, os.environ['WA_APP_SECRET'], os.environ['WA_PHONE_ID'], os.environ['WA_VERIFY_TOKEN'])
    if args.send_one:
        print(bot.send_one(os.environ['WA_ACCESS_TOKEN'], os.environ['WA_API_VERSION']))
    else:
        print(f'Local webhook: http://127.0.0.1:{args.port}/webhook (outbox only; no live sends)')
        ThreadingHTTPServer(('127.0.0.1', args.port), handler(bot)).serve_forever()
