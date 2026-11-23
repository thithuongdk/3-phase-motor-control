# Arduino Uno điều khiển nghịch lưu ba pha

Mạch xếp ngang từ Arduino Uno qua ba bo gate driver U/V/W, ba module nửa cầu SEMiX402GB066HDs và động cơ cảm ứng ba pha. Mỗi bo có hai kênh độc lập A2415S + HCPL-3120, cấp gate cho IGBT high-side và low-side. AVR8js chạy firmware đã biên dịch và truyền sáu tín hiệu SVPWM 10 kHz đến CircuitJS theo thời gian mô phỏng.

Firmware chia góc điện thành sáu sector, tính thời gian cho hai vector kề nhau rồi phân bổ thời gian còn lại cho hai vector zero. Ví dụ ở sector 1, chuỗi đối xứng là `000 → 100 → 110 → 111 → 110 → 100 → 000`. Ba bit ứng với khóa trên U/V/W. Mỗi lần chuyển trạng thái của một nhánh, firmware tắt khóa đang dẫn và chờ dead time trước khi bật khóa đối diện.

Firmware xác định thứ tự cạnh trước mỗi nửa chu kỳ PWM. Các cạnh cách nhau tối đa 10 nhịp Timer1 dùng chung một lần ghi cổng ở điểm giữa. Thời điểm bật khóa đối diện được tính từ lúc khóa trước thực sự tắt, với dead time tối thiểu 4 µs.

Trên giao diện, đặt tốc độ đồng bộ bằng RPM, gạt công tắc **Thuận/Nghịch** rồi bấm **Chạy**. Thanh đi đến 3.000 RPM để thử vùng lỗi. Firmware demo phát từ 5 đến 75 Hz (150–2.250 RPM đồng bộ) và tăng tần số tối đa 18 Hz mỗi mili giây mô phỏng. Giới hạn vận hành của mô phỏng là 2.250 RPM. Vượt giới hạn sẽ ngắt PWM và cần hạ tốc độ đặt rồi bấm **Chạy** lại. Bảng rotor hiển thị RPM và chiều từ mô hình động cơ. Thanh **Quán tính rotor** chỉnh trực tiếp mômen quán tính từ 0,0010 đến 0,0200 kg·m², mặc định 0,0030 kg·m². Nút **Phóng to sơ đồ** mở toàn màn hình. Nhấp đúp vào một bo gate driver hoặc module SEMiX để xem hai kênh H/L, rồi nhấp đúp vào kênh để xem linh kiện.

Sơ đồ chi tiết vẽ đường tín hiệu, đường nguồn và đường dòng bằng dây nối. Bảng tốc độ so sánh RPM rotor với tốc độ từ trường 30 × f của mô hình 4 cực. Đồ thị **Tần số đầu ra Arduino** đọc tần số đang phát từ firmware và đo độ trễ khi khởi động bằng giây thực lẫn giây mô phỏng. Phần **Cách đọc hiện sóng** giải thích năm ô đo.

Tab **UVW → αβ → dq** hiển thị ba chu kỳ xung UH/VH/WH căn theo Timer1, kèm duty cycle của chu kỳ cuối. Công tắc **Lọc gợn vector αβ** chọn giữa điện áp động cơ trung bình mỗi chu kỳ PWM và cùng số đo sau lọc trong hệ dq. Hai biên độ hiển thị đồng thời. Trục d lấy góc điện SVPWM từ Arduino, trục q đi trước d 90°. Hình rotor dùng góc cơ và RPM của CircuitJS.

Thanh **Hệ số thời gian** đặt nhịp yêu cầu từ 1× (quan sát chậm) đến 100× (hết mức cấu hình), mặc định 10×. Bộ giải giới hạn thời gian xử lý trong mỗi lượt để giữ giao diện phản hồi và dùng cùng bước tính của mạch. Nhịp thực đo theo mili giây mô phỏng trên mỗi giây thực.

## Triển khai trên Vercel

Import repo này từ GitHub. Cấu hình trong `vercel.json` phục vụ trực tiếp thư mục `public/` dưới dạng site tĩnh. Khi đã liên kết repo, Vercel tự triển khai các lần push lên nhánh production đã chọn.

## Tệp chính

- `public/ArduinoInverter/` có Arduino sketch và firmware HEX chạy trong AVR8js.
- `public/arduino-inverter.circuitjs` có sơ đồ bốn khối. Trang mô phỏng cấp sáu xung vào mạch qua các nguồn External Voltage.
- `source/` có mã tích hợp JavaScript, nguồn CircuitJS gốc và bản vá `CircuitJS-rotor-layout.patch` cho phép nhận PWM trong khối Arduino và đọc góc, RPM của rotor. Giấy phép nằm trong `public/licenses/`.

Mô hình dùng điều khiển V/f vòng hở. Mỗi kênh lấy +15 V và COM từ nguồn cách ly A2415S-2WR3 (2 W) mô phỏng lý tưởng. COM nối VEE của HCPL-3120 và emitter của IGBT. Tầng ra tích hợp của HCPL-3120 kích gate qua điện trở 8,2 Ω dùng trong mô phỏng. Bấm đúp IC để xem mạch tương đương của phần cách ly quang và tầng ra kéo lên/kéo xuống.
