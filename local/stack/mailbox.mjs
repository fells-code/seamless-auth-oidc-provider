// A local mailbox standing in for SES: the API's sign-in emails land here.
// GET /            the latest emails, for a person signing in in a browser
// GET /codes/<to>  the codes sent to an address, newest last, for scripts
import { createServer } from 'node:http';

const emails = [];

function read(req, res) {
  if (req.url.startsWith('/codes/')) {
    const to = decodeURIComponent(req.url.slice('/codes/'.length));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(emails.filter((e) => e.to === to && e.code).map((e) => e.code)));
    return;
  }
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.end(
    emails
      .slice(-20)
      .reverse()
      .map((e) => `${e.at}  ${e.to}  ${e.code ?? e.text.slice(0, 200)}`)
      .join('\n') || 'No email yet.\n',
  );
}

// SESv2 SendEmail (POST /v2/email/outbound-emails), as the API's client sends it.
function receive(body, res) {
  const message = JSON.parse(body || '{}');
  const content = message.Content?.Simple?.Body ?? {};
  const text = `${content.Text?.Data ?? ''} ${(content.Html?.Data ?? '').replace(/<[^>]+>/g, ' ')}`
    .replace(/\s+/g, ' ')
    .trim();
  emails.push({
    at: new Date().toISOString(),
    to: message.Destination?.ToAddresses?.[0] ?? null,
    code: /code is:? ([A-Z0-9]{6})/.exec(text)?.[1] ?? null,
    text,
  });
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ MessageId: `local-${emails.length}` }));
}

createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => (req.method === 'GET' ? read(req, res) : receive(body, res)));
}).listen(8025, '0.0.0.0');
