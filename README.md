# Arduino Uno điều khiển nghịch lưu ba pha

Mô phỏng Arduino Uno, sáu gate driver cách ly, cầu IGBT 300 V và động cơ cảm ứng ba pha. AVR8js chạy firmware đã biên dịch và truyền sáu tín hiệu SPWM 10 kHz đến CircuitJS theo thời gian mô phỏng.

Trên giao diện, đặt tần số điện từ 5 đến 50 Hz, chọn chiều rồi bấm **Chạy**. Tốc độ rotor hiển thị từ mô hình động cơ. Nút **Phóng to sơ đồ** mở toàn màn hình. Nhấp đúp vào khối `ISO DRIVE` hoặc `IGBT` để xem linh kiện.

## Triển khai trên Vercel

Import repo này từ GitHub. Cấu hình trong `vercel.json` phục vụ trực tiếp thư mục `public/` dưới dạng site tĩnh. Khi đã liên kết repo, Vercel tự triển khai các lần push lên nhánh production đã chọn.

## Tệp chính

- `public/ArduinoInverter/` có Arduino sketch và firmware HEX chạy trong AVR8js.
- `public/arduino-inverter.circuitjs` có sơ đồ bốn khối. Trang mô phỏng cấp sáu xung vào mạch qua các nguồn External Voltage.
- `source/` có mã tích hợp JavaScript và nguồn CircuitJS tương ứng. Giấy phép nằm trong `public/licenses/`.

Mô hình dùng điều khiển V/f vòng hở, gate driver và IGBT tương đương để quan sát dạng sóng và vận hành.
