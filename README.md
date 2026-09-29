# Sınav Tarayıcı

Sabit sınav şablonunun üst bölümündeki ders, öğrenci ve puan bilgilerini telefon kamerasından okuyup öğretmen kontrolüyle Excel'e aktaran mobil web uygulaması.

## İlk sürümde bulunanlar

- Telefonun arka kamerası veya galeriden fotoğraf seçimi
- Sabit üst şablona göre alan kırpma
- Ücretsiz Tesseract.js ile tarayıcı içinde Türkçe metin ve sayı okuma
- Ders kodu/adı ve Soru–PÇ eşleşmelerini ilk kâğıttan okuma
- Öğretmen doğrulama formu ve toplam not kontrolü
- Aynı öğrenci numarası için mükerrer kayıt uyarısı
- Cihazda yerel kayıt
- Soru, PÇ ve toplam not ortalamalarını içeren `.xlsx` çıktısı

## Çalıştırma

```bash
npm install
npm run dev
```

Üretim derlemesi:

```bash
npm run build
```

Kamera erişimi için üretimde HTTPS kullanılmalıdır. İlk OCR çalıştırmasında ücretsiz Türkçe ve İngilizce dil modelleri tarayıcı tarafından indirilir; sonraki kullanımlarda tarayıcı önbelleğinden yararlanılır.

## Sonraki doğruluk aşaması

Sabit kırpma koordinatları, farklı telefonlardan çekilecek gerçek sınav kâğıtlarıyla kalibre edilmelidir. Öğretmen düzeltmelerinden oluşan anonimleştirilmiş örnekler yeterli seviyeye geldiğinde puanlar ve öğrenci numarası için özel bir rakam modeli eklenebilir.
