# Arduino Uno điều khiển nghịch lưu ba pha

Mạch xếp ngang từ Arduino Uno qua ba bo gate driver U/V/W, ba module nửa cầu SEMiX402GB066HDs và động cơ cảm ứng ba pha. Mỗi bo có hai kênh độc lập A2415S + HCPL-3120, cấp gate cho IGBT high-side và low-side. AVR8js chạy firmware đã biên dịch và truyền sáu tín hiệu SPWM 10 kHz đến CircuitJS theo thời gian mô phỏng.

Trên giao diện, đặt tần số điện từ 5 đến 50 Hz, gạt công tắc **Thuận/Nghịch** rồi bấm **Chạy**. Bảng rotor hiển thị RPM và chiều từ mô hình động cơ. Hình rotor phóng đại chuyển động và mô hình dùng quán tính rotor 0,0067 kg·m² để dễ quan sát khởi động. Nút **Phóng to sơ đồ** mở toàn màn hình. Nhấp đúp vào một bo gate driver hoặc module SEMiX để xem hai kênh H/L, rồi nhấp đúp vào kênh để xem linh kiện.

Sơ đồ chi tiết vẽ đường tín hiệu, đường nguồn và đường dòng bằng dây nối. Bảng tốc độ so sánh RPM rotor với tốc độ từ trường 30 × f theo tần số đặt và tần số đang phát của mô hình 4 cực. Phần **Cách đọc hiện sóng** giải thích thứ tự năm ô đo và cách đọc đơn vị theo ô lưới.

## Triển khai trên Vercel

Import repo này từ GitHub. Cấu hình trong `vercel.json` phục vụ trực tiếp thư mục `public/` dưới dạng site tĩnh. Khi đã liên kết repo, Vercel tự triển khai các lần push lên nhánh production đã chọn.

## Tệp chính

- `public/ArduinoInverter/` có Arduino sketch và firmware HEX chạy trong AVR8js.
- `public/arduino-inverter.circuitjs` có sơ đồ bốn khối. Trang mô phỏng cấp sáu xung vào mạch qua các nguồn External Voltage.
- `source/` có mã tích hợp JavaScript, nguồn CircuitJS gốc và bản vá `CircuitJS-rotor-layout.patch` cho phép nhận PWM trong khối Arduino và đọc góc, RPM của rotor. Giấy phép nằm trong `public/licenses/`.

Mô hình dùng điều khiển V/f vòng hở. Mỗi kênh lấy +15 V và COM từ nguồn cách ly A2415S mô phỏng lý tưởng. COM nối VEE của HCPL-3120 và emitter của IGBT. Tầng ra tích hợp của HCPL-3120 kích gate qua điện trở 8,2 Ω dùng trong mô phỏng. Bấm đúp IC để xem mạch tương đương của phần cách ly quang và tầng ra kéo lên/kéo xuống.
