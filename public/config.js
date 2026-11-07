/* ตั้งค่าของร้าน: คัดลอกค่าจาก Firebase Console > Project settings > Your apps > Web app */
window.CS_CONFIG = {
  firebase: {
    apiKey: "ใส่ค่าจาก Firebase",
    authDomain: "YOUR-PROJECT.firebaseapp.com",
    projectId: "YOUR-PROJECT",
    appId: "ใส่ค่าจาก Firebase"
  },
  lineOA: "@cs2016",          /* LINE OA ของร้าน */
  region: "asia-southeast1"   /* ต้องตรงกับ region ของ functions (ดู functions/index.js) */
};
