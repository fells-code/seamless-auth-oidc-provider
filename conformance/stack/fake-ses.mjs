// Stands in for SES so the API's direct email delivery works; the runner reads codes back.
import { createServer } from 'node:http';

const inbox = new Map();
const port = Number(process.env.FAKE_SES_PORT ?? 4590);

createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    if (req.method === 'GET' && req.url.startsWith('/emails/')) {
      const to = decodeURIComponent(req.url.slice('/emails/'.length));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(inbox.get(to) ?? []));
      return;
    }
    const params = new URLSearchParams(body);
    const to = params.get('Destination.ToAddresses.member.1');
    const text = [params.get('Message.Body.Text.Data'), params.get('Message.Body.Html.Data')].join(
      '\n',
    );
    const code = /code is: ([A-Z0-9]{6})/.exec(text)?.[1] ?? null;
    if (to) inbox.set(to, [...(inbox.get(to) ?? []), { code, at: Date.now() }]);
    console.log(
      'email',
      to,
      code ??
        `no code in: ${text
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .slice(0, 300)}`,
    );
    res.setHeader('content-type', 'text/xml');
    res.end(
      '<SendEmailResponse xmlns="http://ses.amazonaws.com/doc/2010-12-01/"><SendEmailResult><MessageId>m-1</MessageId></SendEmailResult><ResponseMetadata><RequestId>r-1</RequestId></ResponseMetadata></SendEmailResponse>',
    );
  });
}).listen(port, '127.0.0.1', () => console.log(`fake SES on ${port}`));
