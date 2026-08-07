/**
 * A miniature "internal app" used to verify agentBrowser end to end.
 *
 * It deliberately reproduces the two things that motivated the project:
 *   1. a real login form that must be filled before anything else works, and
 *   2. two upload paths — a plain <input type=file>, and a styled button that
 *      opens a hidden picker, which is the pattern in-page automation cannot do.
 */
import http from "node:http";

const SESSION_COOKIE = "fixture_session=ok";
const USERNAME = "admin";
const PASSWORD = "s3cret-fixture-pw";

/** Uploads received so far, so the test can assert the bytes really arrived. */
export const received = [];

function html(body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Fixture Internal App</title></head><body>${body}</body></html>`;
}

const LOGIN_PAGE = html(`
  <h1>Internal Tool Login</h1>
  <form method="POST" action="/login">
    <label for="user">Username</label>
    <input id="user" name="username" type="text" placeholder="Username">
    <label for="pw">Password</label>
    <input id="pw" name="password" type="password" placeholder="Password">
    <button type="submit">Sign in</button>
  </form>
`);

const DASHBOARD_PAGE = html(`
  <h1>Dashboard</h1>
  <p>Signed in as admin.</p>

  <h2>Direct upload</h2>
  <form id="direct" method="POST" action="/upload" enctype="multipart/form-data">
    <label for="plainfile">Attach document</label>
    <input id="plainfile" name="document" type="file">
    <button type="submit">Upload document</button>
  </form>

  <h2>Styled upload</h2>
  <form id="styled" method="POST" action="/upload" enctype="multipart/form-data">
    <input id="hiddenfile" name="document" type="file" style="display:none">
    <button type="button" id="pick">Choose file…</button>
    <span id="chosen"></span>
    <button type="submit">Upload chosen</button>
  </form>

  <script>
    document.getElementById('pick').addEventListener('click', function () {
      document.getElementById('hiddenfile').click();
    });
    document.getElementById('hiddenfile').addEventListener('change', function (e) {
      document.getElementById('chosen').textContent =
        e.target.files.length ? 'Selected: ' + e.target.files[0].name : '';
    });
  </script>
`);

function isAuthed(request) {
  return (request.headers.cookie ?? "").includes(SESSION_COOKIE);
}

/** Pulls filename + body out of a multipart payload. Enough for a test fixture. */
function parseMultipart(buffer, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? "");
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (!boundary) return [];

  const parts = [];
  const sep = Buffer.from(`--${boundary}`);
  let index = buffer.indexOf(sep);

  while (index !== -1) {
    const next = buffer.indexOf(sep, index + sep.length);
    if (next === -1) break;
    const chunk = buffer.subarray(index + sep.length, next);
    const headerEnd = chunk.indexOf("\r\n\r\n");
    if (headerEnd !== -1) {
      const headers = chunk.subarray(0, headerEnd).toString("utf8");
      const filename = /filename="([^"]*)"/i.exec(headers)?.[1];
      if (filename) {
        // Trailing CRLF belongs to the delimiter, not the content.
        const content = chunk.subarray(headerEnd + 4, chunk.length - 2);
        parts.push({ filename, size: content.length, content: content.toString("utf8") });
      }
    }
    index = next;
  }
  return parts;
}

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on("data", (c) => chunks.push(c));
    request.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

export function startFixture(port = 0) {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");

    if (url.pathname === "/" || url.pathname === "/login") {
      if (request.method === "POST") {
        const body = await readBody(request);
        const form = new URLSearchParams(body.toString("utf8"));
        if (form.get("username") === USERNAME && form.get("password") === PASSWORD) {
          response.writeHead(302, { "Set-Cookie": SESSION_COOKIE + "; Path=/", Location: "/dashboard" });
          response.end();
          return;
        }
        response.writeHead(401, { "Content-Type": "text/html" });
        response.end(html("<h1>Invalid credentials</h1><a href='/'>Try again</a>"));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(LOGIN_PAGE);
      return;
    }

    if (url.pathname === "/dashboard") {
      if (!isAuthed(request)) {
        response.writeHead(302, { Location: "/" });
        response.end();
        return;
      }
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(DASHBOARD_PAGE);
      return;
    }

    if (url.pathname === "/upload" && request.method === "POST") {
      if (!isAuthed(request)) {
        response.writeHead(403, { "Content-Type": "text/html" });
        response.end(html("<h1>Forbidden</h1>"));
        return;
      }
      const body = await readBody(request);
      const files = parseMultipart(body, request.headers["content-type"]);
      received.push(...files);
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(
        html(
          `<h1>Upload complete</h1><p id="result">Received ${files.length} file(s): ${files
            .map((f) => `${f.filename} (${f.size} bytes)`)
            .join(", ")}</p>`,
        ),
      );
      return;
    }

    response.writeHead(404, { "Content-Type": "text/html" });
    response.end(html("<h1>Not found</h1>"));
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({ server, port: server.address().port, received, USERNAME, PASSWORD });
    });
  });
}

// Allow running standalone for manual poking.
if (process.argv[1] && process.argv[1].endsWith("fixture-server.mjs")) {
  const { port } = await startFixture(Number(process.env.PORT ?? 8899));
  console.log(`fixture app on http://127.0.0.1:${port}  (${USERNAME} / ${PASSWORD})`);
}
