import { createClient } from "@supabase/supabase-js";
import Busboy from "busboy";
import express from "express";
import fs from "fs";
import { loadEnvFile } from "node:process";
import path from "path";
import sharp from "sharp";
import { LoginQRCallbackEventType, ThreadType, Zalo } from "zca-js";

if (!process.env.VERCEL) {
  try {
    loadEnvFile(".env");
  } catch {}
}

const app = express();
app.use(express.json());

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "http://localhost:3000";

let latestQrBase64 = null;
let api = null;
let connected = false;
let loginMode = null;
let loginPromise = null;
let supabase = null;

function getSupabase() {
  if (supabase) return supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  supabase = createClient(url, key, { auth: { persistSession: false } });
  return supabase;
}

function requireSecret(req, res, next) {
  const secret = process.env.SESSION_SECRET;
  const provided = req.headers["x-session-secret"];
  if (!secret)
    return res.status(500).json({ error: "SESSION_SECRET is not configured" });
  if (provided !== secret)
    return res.status(401).json({ error: "Unauthorized" });
  next();
}

async function imageMetadataGetter(filePath) {
  const data = await fs.promises.readFile(filePath);
  const metadata = await sharp(data).metadata();
  return {
    height: metadata.height,
    width: metadata.width,
    size: metadata.size || data.length,
  };
}

const zalo = new Zalo({
  selfListen: true,
  checkUpdate: true,
  logging: true,
  imageMetadataGetter,
});

function attachListenerState(currentApi) {
  if (!currentApi?.listener) return;
  currentApi.listener.start();
  currentApi.listener.on("connected", () => {
    connected = true;
    console.log("Zalo listener connected");
  });
  currentApi.listener.on("disconnected", () => {
    connected = false;
    console.log("Zalo listener disconnected");
  });
}

async function getActiveCredential() {
  const db = getSupabase();
  if (!db) return null;
  const { data, error } = await db
    .from("zalo_sessions")
    .select("*")
    .eq("is_active", true)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function saveCredential(payload) {
  const db = getSupabase();
  if (!db) {
    console.error("Thiếu Supabase config");
    return;
  }
  const { error } = await db.from("zalo_sessions").upsert({
    id: "primary",
    is_active: true,
    qr_base64: null,
    credentials: payload,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}

//  MỚI: Xóa session cũ + QR cũ trong DB
async function clearStaleSession() {
  const db = getSupabase();
  if (!db) return;
  try {
    const { error } = await db.from("zalo_sessions").upsert({
      id: "primary",
      is_active: false,
      qr_base64: null,
      credentials: null,
      updated_at: new Date().toISOString(),
    });
    if (error) console.error("Xóa session cũ lỗi:", error.message);
  } catch (e) {
    console.error("Xóa session cũ lỗi:", e.message);
  }
}

async function saveQrToDb(qrBase64) {
  const db = getSupabase();
  if (!db) return;
  try {
    const { error } = await db.from("zalo_sessions").upsert({
      id: "primary",
      is_active: false,
      qr_base64: qrBase64,
      updated_at: new Date().toISOString(),
    });
    if (error) console.error("Lưu QR vào DB lỗi:", error.message);
  } catch (e) {
    console.error("Lưu QR vào DB lỗi:", e.message);
  }
}

//  MỚI: Reset toàn bộ state về ban đầu
function resetLoginState() {
  api = null;
  connected = false;
  loginMode = null;
  loginPromise = null;
  latestQrBase64 = null;
}

async function loginByDb() {
  const row = await getActiveCredential().catch(() => null);
  if (!row?.credentials) return false;
  try {
    api = await zalo.login(row.credentials);
    loginMode = "credentials-db";
    attachListenerState(api);
    console.log("Auto-login bằng DB thành công");
    return true;
  } catch (e) {
    console.error("Login DB lỗi:", e.message);
    //  Session hết hạn → xóa để không dùng lại
    await clearStaleSession();
    return false;
  }
}

function startQrLogin() {
  if (api || loginPromise) return;
  loginMode = "qr";
  latestQrBase64 = null; //  Reset QR cũ trong RAM

  loginPromise = zalo
    .loginQR({}, async (event) => {
      if (!event) return;
      if (event.type === LoginQRCallbackEventType.QRCodeGenerated) {
        const img = event?.data?.image;
        if (!img) return;
        latestQrBase64 = img;
        await saveQrToDb(img); //  Lưu QR mới vào DB
        console.log(`QR mới đã tạo. Mở: ${PUBLIC_BASE_URL}/login-qr`);
        return;
      }
      if (event.type === LoginQRCallbackEventType.GotLoginInfo) {
        console.log("Nhận login info, đang lưu vào DB...");
        saveCredential(event.data).catch((e) =>
          console.error("Lưu DB lỗi:", e.message),
        );
      }
    })
    .then((loggedApi) => {
      api = loggedApi;
      latestQrBase64 = null;
      attachListenerState(api);
      console.log("Đăng nhập QR thành công");
    })
    .catch((e) => console.error("QR login lỗi:", e.message, e.stack))
    .finally(() => {
      loginPromise = null;
    });
}

async function initZalo() {
  console.log("Init Zalo...");
  const ok = await loginByDb();
  if (!ok) startQrLogin();
}

initZalo();

//  /login-qr: Luôn tạo QR mới nếu chưa login hoặc ?force=1
app.get("/login-qr", async (req, res) => {
  const forceNew = req.query.force === "1" || !api;

  if (forceNew && !loginPromise) {
    resetLoginState();
    await clearStaleSession();
    startQrLogin();
  }

  // Đợi tối đa 8 giây để QR được tạo
  const deadline = Date.now() + 8000;
  while (!latestQrBase64 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
  }

  if (!latestQrBase64) {
    return res.status(202).send(`
      <!doctype html><html><head><meta charset="utf-8"/>
      <meta http-equiv="refresh" content="3"/>
      <title>Zalo Login QR</title></head>
      <body style="font-family:sans-serif;padding:24px">
        <h3>⏳ Đang tạo QR, tự động refresh sau 3 giây...</h3>
        <p>Nếu quá lâu hãy <a href="/login-qr?force=1">bấm vào đây để tạo lại QR mới</a>.</p>
      </body></html>
    `);
  }

  res.send(`
    <!doctype html><html><head><meta charset="utf-8"/>
    <title>Zalo Login QR</title></head>
    <body style="font-family:sans-serif;padding:24px">
      <h3>📱 Quét QR để đăng nhập Zalo</h3>
      <p>QR này mới tạo lúc ${new Date().toLocaleTimeString("vi-VN")}.
         Nếu hết hạn, <a href="/login-qr?force=1">bấm đây để tạo QR mới</a>.</p>
      <img src="data:image/png;base64,${latestQrBase64}"
           style="max-width:320px;border:1px solid #ccc" alt="Zalo login QR"/>
    </body></html>
  `);
});

app.get("/health", (_, res) => {
  res.json({
    ok: true,
    loggedIn: !!api,
    connected,
    loginMode,
    hasLoginQr: !!latestQrBase64,
    hasSupabase: !!getSupabase(),
    publicBaseUrl: PUBLIC_BASE_URL,
  });
});

app.post("/find-user-by-phone", requireSecret, async (req, res) => {
  try {
    const { phone } = req.body;
    if (!api) return res.status(503).json({ error: "Chưa đăng nhập Zalo" });
    if (!phone) return res.status(400).json({ error: "phone is required" });
    const user = await api.findUser(phone);
    return res.json({ phone, user });
  } catch (e) {
    return res.status(500).json({ error: e.message, stack: e.stack });
  }
});

function handleFileUpload(req) {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: req.headers });
    const fields = {};
    let tmpPath = null;
    let writeStream = null;
    busboy.on("field", (name, value) => {
      fields[name] = value;
    });
    busboy.on("file", (_, file, info) => {
      const tmpName = `${Date.now()}-${info.filename}`;
      tmpPath = path.join("/tmp", tmpName);
      fs.mkdirSync("/tmp", { recursive: true });
      writeStream = fs.createWriteStream(tmpPath);
      file.pipe(writeStream);
    });
    busboy.on("finish", () => resolve({ fields, tmpPath, writeStream }));
    busboy.on("error", reject);
    req.pipe(busboy);
  });
}

app.post("/send-root-qr-by-phone", requireSecret, async (req, res) => {
  let tmpPath = null;
  try {
    const contentType = req.headers["content-type"] || "";
    if (!contentType.includes("multipart/form-data"))
      return res.status(415).json({
        error: "Unsupported content type",
        expected: "multipart/form-data",
      });

    const { fields, tmpPath: tp, writeStream } = await handleFileUpload(req);
    tmpPath = tp;
    if (!fields.phone)
      return res.status(400).json({ error: "phone is required" });
    if (!tmpPath) return res.status(400).json({ error: "file is required" });
    if (!api) return res.status(503).json({ error: "Chưa đăng nhập Zalo" });
    if (!connected)
      return res.status(503).json({ error: "Zalo chưa connected listener" });

    await new Promise((resolve, reject) => {
      writeStream.on("finish", resolve);
      writeStream.on("error", reject);
    });

    const user = await api.findUser(fields.phone);
    const threadId = user?.uid;
    if (!threadId) {
      await fs.promises.unlink(tmpPath).catch(() => {});
      return res
        .status(404)
        .json({ error: "Không tìm thấy user Zalo theo số điện thoại" });
    }
    const result = await api.sendMessage(
      { msg: fields.caption || "Ảnh gửi từ hệ thống", attachments: [tmpPath] },
      threadId,
      ThreadType.User,
    );
    await fs.promises.unlink(tmpPath).catch(() => {});
    return res.json({ ok: true, phone: fields.phone, user, threadId, result });
  } catch (e) {
    if (tmpPath) await fs.promises.unlink(tmpPath).catch(() => {});
    return res.status(500).json({ error: e.message, stack: e.stack });
  }
});

app.post("/upload-and-send", requireSecret, async (req, res) => {
  let tmpPath = null;
  try {
    const contentType = req.headers["content-type"] || "";
    if (!contentType.includes("multipart/form-data"))
      return res.status(415).json({
        error: "Unsupported content type",
        expected: "multipart/form-data",
      });

    const { fields, tmpPath: tp, writeStream } = await handleFileUpload(req);
    tmpPath = tp;
    if (!fields.phone)
      return res.status(400).json({ error: "phone is required" });
    if (!tmpPath) return res.status(400).json({ error: "file is required" });
    if (!api) return res.status(503).json({ error: "Chưa đăng nhập Zalo" });
    if (!connected)
      return res.status(503).json({ error: "Zalo chưa connected listener" });

    await new Promise((resolve, reject) => {
      writeStream.on("finish", resolve);
      writeStream.on("error", reject);
    });

    const user = await api.findUser(fields.phone);
    const threadId = user?.uid;
    if (!threadId) {
      await fs.promises.unlink(tmpPath).catch(() => {});
      return res
        .status(404)
        .json({ error: "Không tìm thấy user Zalo theo số điện thoại" });
    }
    const result = await api.sendMessage(
      { msg: fields.caption || "Ảnh gửi từ hệ thống", attachments: [tmpPath] },
      threadId,
      ThreadType.User,
    );
    await fs.promises.unlink(tmpPath).catch(() => {});
    return res.json({ ok: true, phone: fields.phone, user, threadId, result });
  } catch (e) {
    if (tmpPath) await fs.promises.unlink(tmpPath).catch(() => {});
    return res.status(500).json({ error: e.message, stack: e.stack });
  }
});

app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err.message || "Internal Server Error" });
});

if (!process.env.VERCEL) {
  app.listen(3000, () => {
    console.log("Server chạy ở http://localhost:3000");
  });
}

export default app;
