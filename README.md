# Sınav Tarayıcı

Sabit sınav şablonunun üst bölümündeki ders, öğrenci ve puan bilgilerini telefon kamerasından okuyup öğretmen kontrolüyle Excel'e aktaran mobil web uygulaması.

## Özellikler

- Telefonun arka kamerası veya galeriden fotoğraf seçimi
- Üst tablonun doğal görüntüsü korunarak yerel Qwen3.5-4B ile basılı metin ve el yazısı okuma
- Tek okuma veya iki ayrı okuma isteğinin sonuçlarını karşılaştıran çift kontrol
- Ders kodu/adı ve Soru–PÇ eşleşmelerini ilk kâğıttan okuma
- Öğretmen doğrulama formu, farklı okuma alternatifleri ve toplam not kontrolü
- Aynı öğrenci numarası için mükerrer kayıt uyarısı
- Cihazda yerel kayıt
- Soru, PÇ ve toplam not ortalamalarını içeren `.xlsx` çıktısı

## Yerel kurulum ve çalıştırma

Node.js 22.18+ (önerilen 24) ve Windows x64 gerekir. Model **telefon üzerinde değil, uygulamayı çalıştıran bilgisayarda** çalışır. Telefon bu bilgisayara bağlanır, fotoğrafı gönderir ve sonuçları gösterir. Ücretli API, API anahtarı veya öğrenci listesi gerekmez.

```bash
npm install
npm run reader:setup
npm run dev
```

`reader:setup`, resmî Ollama Windows paketini (v0.35.0, SHA-256 doğrulamalı) ve varsayılan `qwen3.5:4b` modelini indirir. Model yaklaşık 3,4 GB; motor ve açılan paket ayrıca disk alanı gerektirir. Dosyalar proje içindeki `work/reader/` altında kalır ve Git'e eklenmez. İnternet ilk kurulum/indirme için gerekir; tarama sırasında haricî bir servise fotoğraf gönderilmez.

`npm run dev` ve `npm start` yerel motoru otomatik başlatmayı dener. Motor sadece `127.0.0.1:11435` üzerinde dinler; telefondan bu porta erişim gerekmez. Fotoğraflar aynı web uygulamasının `/api/reader` adresinden işlenir. Motor kurulu değilse ekran bunu bildirir; sessizce daha zayıf bir motora geçilmez. Elle giriş kullanılabilir.

Telefonla denemek için aynı güvenilir ağda, bilgisayarın IPv4 adresiyle `http://BILGISAYAR_IP:5173` açılır. Tarayıcı içinden canlı kamera için HTTPS gerekir; HTTP bağlantısında cihazın fotoğraf çekme/seçme ekranı kullanılır. Hassas öğrenci verileri için güvenilir yerel ağ veya HTTPS kullanın.

Üretim çalıştırması:

```bash
npm run build
npm start
```

Bu yapı, modelin çalıştığı bilgisayarda bir Node.js sunucusu gerektirir; yalnızca statik dosya barındırmak otomatik okumayı çalıştırmaz. Bilgisayar açık ve sunucu çalışır durumda olmalıdır.

## Doğrulama kuralları

- İsim ve öğrenci numarası, önceden öğrenci listesi bulunmadığı için her zaman öğretmen kontrolüne sunulur. Baştaki sıfırlar korunur.
- Model çıktısına ölçülmemiş doğruluk yüzdeleri atanmaz. İki model isteğinin anlaşması da kesin doğruluk kanıtı değildir.
- Kâğıtta yazan not ile puanların toplamı ayrı tutulur. Uyuşmazlık gösterilir; puan veya toplam not otomatik değiştirilmez.
- Boş/okunamayan puan sıfıra çevrilmez, toplam not türetilmez. Eksik/geçersiz sayılarla kayıt yapılmaz.
- Çift kontrolde farklı değerler varsa ilk okuma korunur ve alternatifler gösterilir. İkinci okuma başarısızsa ilk sonuç korunur, çift kontrol tamamlanmış gibi gösterilmez.
- İlk kâğıtta modelin yüklenmesi sonraki kâğıtlardan uzun sürebilir. Gerçek süre kontrol ekranında gösterilir; tek örnekten genel doğruluk veya hız garantisi çıkarılmaz.
- Uygulama otomatik öğrenci kaydı yapmaz; öğretmen onayı gerekir. Kayıtlar ve Excel dışa aktarma tarayıcıda kalır; fotoğraflar sunucuda dosyaya kaydedilmez.

Önceki Tesseract okuyucusu karşılaştırma amacıyla `lib/tesseract-reader.ts` içinde korunur; varsayılan tarama akışında kullanılmaz.

## Testler

```bash
npm test
npx tsc --noEmit
npm run build
```

Birim testleri veri doğrulamasını, toplamın değiştirilmemesini, çift kontrol farklılıklarını, yerel bağlantı sınırlarını ve hata durumlarını kapsar. Okuma doğruluğu farklı el yazıları, kırmızı/siyah kalemler ve farklı telefon çekimleriyle ayrıca ölçülmelidir.

Model değişikliği gerektiğinde `SCANEXAM_MODEL`, başka bir yerel motor kullanıldığında `SCANEXAM_READER_URL` ortam değişkenleri ayarlanabilir. Uygulama yalnızca döngüsel yerel adreslere bağlanır; bulut modeli etiketleri kullanılmaz. Windows dışındaki sistemlerde Ollama ayrıca kurulmalıdır.

Yerel model ve runtime kaynakları: [Qwen3.5-4B](https://huggingface.co/Qwen/Qwen3.5-4B) (Apache-2.0), [Ollama](https://github.com/ollama/ollama) (MIT). İndirilen paketlerin lisans dosyaları korunur.
