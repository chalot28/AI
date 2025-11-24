while true
do
  echo "🚀 Đang khởi động Bot..."
  # Chạy file index.js của bạn
  node index.js
  
  # Nếu bot bị crash (tắt), dòng này sẽ chạy
  echo "⚠️ Bot bị crash hoặc tắt! Đang khởi động lại sau 3 giây..."
  sleep 3
done