# zalo-vercel-service

Service Node.js chạy trên **Render** (hoặc bất kỳ platform nào có persistent process) để:

- Đăng nhập Zalo bằng QR
- Lưu session/credentials vào Supabase
- Tự động dùng lại session đã lưu khi restart
- Gửi ảnh Zalo theo số điện thoại qua API

---

## Công nghệ

- **Node.js** + Express + Busboy
- **zca-js** — thư viện Zalo unofficial
- **Supabase** — lưu session & QR
- **sharp** — đọc metadata ảnh
- Deploy: **Render Web Service** (khuyến nghị) / Railway / Fly.io

---

## 1. Chuẩn bị Supabase

### Tạo bảng `zalo_sessions`

Vào **Supabase Dashboard → SQL Editor** rồi chạy:

```sql
CREATE TABLE IF NOT EXISTS public.zalo_sessions (
  id TEXT PRIMARY KEY,
  is_active BOOLEAN NOT NULL DEFAULT false,
  credentials JSONB,
  qr_base64 TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

> Nếu bảng đã tồn tại nhưng chưa có cột `qr_base64`, chạy thêm:
>
> ```sql
> ALTER TABLE zalo_sessions ADD COLUMN IF NOT EXISTS qr_base64 TEXT;
> ```

### Lấy thông tin kết nối

Vào **Project Settings → API**:

- `Project URL` → dùng cho `SUPABASE_URL`
- `service_role` key → dùng cho `SUPABASE_SERVICE_ROLE_KEY`

---

## 2. Biến môi trường

Tạo file `.env` (local) hoặc set trong Render Dashboard:

```env
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGci...
SESSION_SECRET=chuỗi-bí-mật-tùy-ý
PUBLIC_BASE_URL=https://zalo-vercel-service-dev.onrender.com
```

| Biến                        | Mô tả                                      |
| --------------------------- | ------------------------------------------ |
| `SUPABASE_URL`              | URL project Supabase                       |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (toàn quyền DB)           |
| `SESSION_SECRET`            | Secret dùng để bảo vệ các API nhạy cảm     |
| `PUBLIC_BASE_URL`           | URL công khai của service (để log link QR) |

---

## 3. Chạy local

```bash
npm install
npm run dev
```

Service chạy tại `http://localhost:3000`.

Lần đầu chưa có session, mở `http://localhost:3000/login-qr` để quét QR đăng nhập.

---

## 4. Deploy lên Render

1. Push code lên GitHub.
2. Vào [render.com](https://render.com) → **New Web Service** → chọn repo.
3. Cấu hình:
   - **Build Command:** `npm install`
   - **Start Command:** `node api/index.js`
   - **Environment Variables:** điền 4 biến ở trên.
4. Deploy → đợi build xong.
5. Truy cập `https://<service>.onrender.com/login-qr` để đăng nhập lần đầu.

---

## 5. Đăng nhập Zalo lần đầu

Truy cập:
https://<your-domain>/login-qr

text

- Trang tự tạo QR mới (đợi ~3-5 giây nếu chưa hiện).
- Mở app Zalo trên điện thoại → quét QR.
- Sau khi quét thành công, session được lưu tự động vào Supabase.
- Các lần restart sau service tự login lại bằng session đã lưu.

> **QR hết hạn hoặc muốn login lại?** Truy cập:
>
> ```
> https://<your-domain>/login-qr?force=1
> ```

---

## 6. API Reference

Tất cả API nhạy cảm yêu cầu header:
x-session-secret: <SESSION_SECRET>

text

---

### GET `/health`

Kiểm tra trạng thái service. Không cần auth.

**Response:**

```json
{
  "ok": true,
  "loggedIn": true,
  "connected": true,
  "loginMode": "credentials-db",
  "hasLoginQr": false,
  "hasSupabase": true,
  "publicBaseUrl": "https://..."
}
```

---

### GET `/login-qr`

Hiển thị trang QR để đăng nhập Zalo. Không cần auth.

- Tự động tạo QR mới nếu chưa đăng nhập.
- Thêm `?force=1` để reset và tạo QR mới dù đang có session.

---

### POST `/find-user-by-phone`

Tìm thông tin user Zalo theo số điện thoại.

**Headers:**
x-session-secret: <SESSION_SECRET>
Content-Type: application/json

text

**Body:**

```json
{
  "phone": "09*********"
}
```

**Response:**

```json
{
  "phone": "09*********",
  "user": { "uid": "...", "zaloName": "...", ... }
}
```

**Curl:**

```bash
curl -X POST https://<your-domain>/find-user-by-phone \
  -H "x-session-secret: your-secret" \
  -H "Content-Type: application/json" \
  -d '{"phone": "09*********"}'
```

---

### POST `/send-root-qr-by-phone`

Gửi ảnh (ví dụ: QR thanh toán) đến một số điện thoại qua Zalo.

**Headers:**
x-session-secret: <SESSION_SECRET>

text

**Body (multipart/form-data):**

| Field     | Type | Mô tả                          |
| --------- | ---- | ------------------------------ |
| `phone`   | text | Số điện thoại người nhận       |
| `caption` | text | Nội dung tin nhắn kèm ảnh      |
| `file`    | file | File ảnh cần gửi (PNG, JPG...) |

**Response:**

```json
{
  "ok": true,
  "phone": "09******",
  "threadId": "*******",
  "result": { ... }
}
```

**Curl:**

```bash
curl -X POST https://<your-domain>/send-root-qr-by-phone \
  -H "x-session-secret: your-secret" \
  -F "phone=09*********" \
  -F "caption=QR thanh toán của bạn" \
  -F "file=@./payment-qr.png"
```

**Python:**

```python
import os
import requests

url = "https://<your-domain>/send-root-qr-by-phone"

with open("payment-qr.png", "rb") as f:
    response = requests.post(
        url,
        headers={"x-session-secret": "your-secret"},
        data={"phone": "096****8*", "caption": "QR thanh toán của bạn"},
        files={"file": ("payment-qr.png", f, "image/png")},
        timeout=(10, 120),
    )

print(response.status_code, response.json())
```

**Postman:**

1. Method: `POST`
2. URL: `https://<your-domain>/send-root-qr-by-phone`
3. Tab **Headers**: thêm `x-session-secret: your-secret`
4. Tab **Body** → chọn **form-data**:
   - `phone` → Text → `09*********`
   - `caption` → Text → `QR thanh toán của bạn`
   - `file` → **File** → chọn file ảnh
5. Bấm **Send**.

> ⚠️ Không tự set `Content-Type` header khi dùng Postman — Postman tự sinh boundary đúng.

---

### POST `/upload-and-send`

Tương tự `/send-root-qr-by-phone`, dùng cùng format. Endpoint dự phòng / alias.

---

## 7. Lỗi thường gặp

| Lỗi                                  | Nguyên nhân                     | Cách sửa                                  |
| ------------------------------------ | ------------------------------- | ----------------------------------------- |
| `Chưa đăng nhập Zalo` (503)          | Session hết hạn hoặc chưa login | Truy cập `/login-qr?force=1` để login lại |
| `Zalo chưa connected listener` (503) | Listener chưa kết nối           | Đợi vài giây, kiểm tra `/health`          |
| `Không tìm thấy user Zalo` (404)     | Số điện thoại không dùng Zalo   | Kiểm tra lại số điện thoại                |
| `Could not find column qr_base64`    | Thiếu cột trong Supabase        | Chạy `ALTER TABLE` như mục 1              |
| QR hiện xong nhưng quét không được   | QR đã hết hạn                   | Truy cập `/login-qr?force=1`              |
| `ReadTimeout` từ Python client       | Server xử lý lâu                | Dùng `timeout=(10, 120)`                  |
