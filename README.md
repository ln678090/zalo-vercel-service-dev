# zalo-vercel-service

Service Node.js deploy lên Vercel để:
- mở QR login Zalo
- lưu credentials/session lên Supabase
- dùng session đã lưu để gửi ảnh Zalo theo số điện thoại

## Lưu ý

Vercel là serverless nên không phù hợp để giữ WebSocket/persistent listener lâu dài như một Node server truyền thống. Đây phù hợp hơn cho POC, còn production ổn định nên cân nhắc Railway/Fly.io/Northflank. [web:529][web:535]

## Công nghệ
- Vercel Serverless Function
- Supabase Postgres + Storage
- zca-js
- Express + Busboy

## Chuẩn bị Supabase

Tạo bảng:

```sql
create table if not exists public.zalo_sessions (
  id text primary key,
  is_active boolean not null default true,
  credentials jsonb not null,
  updated_at timestamptz not null default now()
);
```

Tạo bucket Storage public nếu bạn vẫn muốn lưu file trung gian hoặc file dùng lại sau này. Bucket public giúp `getPublicUrl()` tạo link tải công khai được. [web:550][web:553][web:560]

## Biến môi trường

Copy `.env.example` và cấu hình:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SESSION_SECRET`
- `PUBLIC_BASE_URL`

## Chạy local

```bash
npm install
vercel dev
```

## API

### 1. Bắt đầu login QR
`GET /login/start`

### 2. Xem QR
`GET /login/qr`

### 3. Health
`GET /health`

### 4. Gửi ảnh qua Zalo
`POST /api/send-by-phone`

Form-data:
- `phone`: số điện thoại
- `description`: mô tả/tin nhắn
- `file`: file ảnh

Header bảo vệ nội bộ:
- `x-internal-secret: <SESSION_SECRET>`

Ví dụ curl:

```bash
curl -X POST http://localhost:3000/api/send-by-phone   -H "x-internal-secret: your-secret"   -F "phone=09xxxxxxxx"   -F "description=Ảnh gửi từ hệ thống"   -F "file=@./payment-qr.png"
```
