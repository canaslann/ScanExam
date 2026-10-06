# Sınav Tarayıcı

Telefon/webcam ile üst formu otomatik yakalar. Bilgisayardaki **GLM-OCR Q8/EOT** modeli sırayla okur; sonuçlar telefon ve bilgisayarın ortak, düzenlenebilir tablosunda görünür. Soru sayısı ve her sorunun PÇ eşleşmesi değişkendir. Excel çıktısı korunmuştur.

## Kurulum

Windows x64, Node.js 22.18+ (önerilen 24):

```bash
npm install
npm run reader:setup
npm run dev
```

Bilgisayarda `http://localhost:5173` açın. OCR telefonda değil bu bilgisayarda çalışır; GPU varsa motor otomatik kullanır, yoksa CPU'ya geçer. Ofis bilgisayarlarında hız garantisi verilmez; hedef donanımda ölçün.

İlk kurulum SHA-256 doğrulamalı Ollama v0.35.0 Windows paketini (~1,46 GB) ve GLM-OCR Q8 paketini (~1,59 GB) indirir. Kuruluysa indirme yapılmaz. `glm-ocr-eot:q8_0` alias'ı sabit SHA-256 ile doğrulanan kaynak GGUF'ye yalnız EOT metadata ekler. Tensor baytları/göreli konumları korunur, veri özetleri karşılaştırılır; kaynak dosya değiştirilmez. Arşiv, açılmış motor, kaynak model, EOT kopyası ve Ollama deposu ayrıca disk alanı gerektirir. `work/` Git dışında kalır.

- `SCANEXAM_MODEL`: varsayılan `glm-ocr-eot:q8_0`; `qwen3.5:4b` eski akışı açıkça seçer. Sessiz model düşürme yok.
- `SCANEXAM_READER_URL`: yalnız HTTP loopback; varsayılan `http://127.0.0.1:11435`. Bulut etiketi kabul edilmez.
- `SCANEXAM_READER_THREADS`: isteğe bağlı 1–64; varsayılan motorun seçimi.
- `SCANEXAM_DATA_DIR`: ortak veritabanı dizini; varsayılan `work/shared`. Dev ve telefon uygulaması **aynı dizini** kullanmalı.

`npm run dev` / `npm start` motoru başlatmayı dener; model için `reader:setup` gerekir. Üretimde `npm run build`, ardından `npm start`. Yalnız statik barındırma yeterli değildir; bilgisayar ve Node.js sunucusu açık kalmalıdır.

## Telefona sertifika kurmadan HTTPS

Telefon kamerası güvenilir HTTPS ister; `http://BILGISAYAR_IP:5173` uygun değildir. Güncel Safari/Chrome/Edge, IndexedDB ve kamera API'si gerekir. Web Locks artık zorunlu değildir; kuyruğu bilgisayar yönetir. Normal tarayıcı kullanın, kamera iznini verin.

Fotoğraf, öğrenci kimliği/notları ve sonuç trafiğinin **Cloudflare üzerinden geçmesine izin varsa**:

```bash
npm run phone
```

Resmî `cloudflared` 2026.10.0 (~55 MB) ilk seferde indirilip sabit SHA-256 ile doğrulanır. Yeni OCR modeli indirilmez. Üretim derlenir, ayrı uygulama/parola geçidi yalnız loopback'te açılır; dev sunucusu korunur. Telefon sertifikası, sistem servisi veya güvenlik duvarı kuralı kurulmaz.

Terminalde çıkan HTTPS adresini telefonda açın. Varsayılan kullanıcı adı ve parola **scanexam**. Bu kolay parola yalnız yetkililerle paylaşılan geçici test içindir; gerçek verilerle kalıcı kullanımda güçlü kimlik doğrulaması gerekir. `SCANEXAM_PHONE_PASSWORD` (en az 8 karakter) ile değiştirilebilir. Bilgiler `work/phone/telefon-baglantisi.txt` içinde, Git dışında kalır.

Parola bütün sayfa, Worker, statik dosya ve API isteklerinde uygulanır. Aynı kaynak/Host denetimi korunur; model portu internete açılmaz. `npm run phone:stop` yalnız telefon uygulaması/tünelini kapatır; dev/model korunur. Yeniden açılınca geçici adres değişir. **Bilgisayara aktarılmış ortak tablo/fotoğraflar korunur ve yeni adresten görünür.** Telefonda aktarılmamış görüntü varsa bağlantıyı kapatmadan tamamlayın: eski origin'in cihaz deposu yeni adrese taşınmaz. Quick Tunnel kalıcı kurumsal dağıtım değildir.

Geliştirmede telefonda da güvenilen, adresinize uygun sertifika varsa `SCANEXAM_HTTPS_CERT` ve `SCANEXAM_HTTPS_KEY` birlikte tanımlanabilir; doğrulama atlanmaz. Kendi üretim HTTPS vekilinizde özgün Host korunmalı ve `SCANEXAM_PUBLIC_ORIGIN` tam HTTPS origin olmalıdır. Gelen forwarded başlıklarına güvenilmez. Dev portu kullanıcı hesabıyla korunmaz; güvenilen ağ dışında yayınlamayın.

## Tarama, ortak tablo ve Excel

1. Ders, **1–30 soru** ve bağımsız **PÇ1–PÇ99** değerlerini ayarlayın. Aynı PÇ birden çok soruya atanabilir. İlk satırdan sonra soru sayısı kilitlenir. Basılı ders/PÇ okumasındaki fark sessizce ayarı değiştirmez.
2. Üst form ve **Puan / Not satırlarının tamamını** hizalayın. En az üç uygun kare ve 500 ms sabitlik gerekir; analiz aralığı 180 ms. Odak/analiz/kayıt ek süre getirir: gerçek telefon süresi garantisi değildir. Aynı sabitlik aralığının en iyi kenar/kontrast karesi seçilir; bu OCR güveni değildir. Renk korunur. Kırmızı/siyah kalem başarısı ışık, kontrast ve el yazısına bağlıdır.
3. **Yeşil tik = görüntü bu cihazın IndexedDB aktarım kuyruğuna kalıcı kaydedildi.** Aktarım/OCR arka plandadır; modeli beklemeden sonraki kâğıda geçin. Tutulan kâğıt tekrar yakalanmaz. Kâğıdı çıkarın veya üst üste değişimde “Sonraki kâğıda hazırla”yı kullanın; yanlış kullanım mükerrer kayıt yaratabilir.
4. Aktarılan fotoğraf/satır bilgisayarda atomik saklanır. Bilgisayar sırayla okur; telefon kapansa da **aktarılmış** işler sürer. Gizlenen sekmede kamera kapanır. Aktarılmamış görüntüler cihazda korunur ve tekrar denenir; aktarım bitene kadar sekmeyi açık tutun.
5. Aynı bilgisayara bağlı cihazlar yaklaşık bir saniyelik sorgularla aynı tabloyu görür. Farklı hücre düzenlemeleri birleşir; aynı hücrede eski değere göre yazma reddedilir. Model, okuma sırasında elle yapılan düzenlemeyi ezmez.
6. Sarı hücreyi kaynak fotoğrafla karşılaştırın; düzenleyin veya “Kontrol” ekranından onaylayın. Yeşil = şüphe bildirilmemesi veya kontrol/düzenleme; kalibre edilmiş güven yüzdesi değildir. İsim/numara önceden öğrenci listesi olmadığından her zaman kontrol ister.
7. Bekleyen/hatalı okumalar, geçersiz hücreler, kimlik, ders/PÇ farkları, mükerrer numaralar ve onaysız toplam uyuşmazlıkları çözülünce **Excel'i indirin**. Soru/PÇ toplamları ve ortalamalar dinamik; öğrenci no baştaki sıfırlarını koruyan metindir.

Sınırlar: cihazda 20 aktarılmamış görüntü/120 MB; bilgisayarda 20 bekleyen-okunan iş/120 MB kaynak fotoğraf ve 2000 satır. Doluluk görünür hata verir, görüntü sessizce atılmaz. Tarama modelden hızlıysa kuyruk dolabilir. Ortak duraklatma/iptal bütün cihazlara uygulanır. Tek/çift tanıma süresi sınırı 120/240 saniyedir. GLM ağırlıkları uygulama açılışında öğrenci görüntüsü gönderilmeden hazırlanır (hazırlık sınırı 180 sn); model boşta bellekten çıkarılmışsa kuyruktaki kâğıt okunmadan bu hazırlık yeniden yapılır. Hazırlık okuma süresine dahil değildir; bu esnada kâğıtlar sırada saklanır, kullanıcı yeni kâğıt tarayabilir. Toplam ilk sonuç beklemesi hazırlık + tanıma + aktarım olduğundan daha uzun olabilir.

## Saklama ve doğruluk

Ortak tablo ve özgün fotoğraflar `work/shared/scanexam.sqlite` içinde SQLite WAL ile saklanır; klasörde kişisel veri vardır. Dev/telefon aynı veritabanını paylaşır. Yeniden başlatmada kalıcı kuyruk sürer, ölmüş lease yeniden alınır. Tek aktif sınav bütün bağlı cihazlara ortaktır; kullanıcı bazlı veya çoklu eşzamanlı sınav yönetimi değildir.

Excel'i düzenli indirin. Veri klasörünü güvenli tutun; yedek için sunucuları kapatıp SQLite ve varsa WAL/SHM dosyalarını birlikte saklayın. “Yeni sınav” onayı ortak tablo/fotoğrafları **bütün cihazlardan kaldırır**. Eski tarayıcı-only veriler otomatik içe alınmaz/silinmez. Özel mod/site verisi temizleme aktarılmamış görüntüleri kaybettirebilir. Bozuk kayıt sessizce boş sınavla değiştirilmez.

GLM gerçek çizgi geometrisinden isim/numara hücrelerini ayırır. İsim renk koruyan 2× ve etiketli hücreden, numara etiketli ve 2× hücreden okunur. Farklar alternatif/sarı uyarı olur. Öğrenci listesiyle tamamlanmaz; harfler sayıya zorla çevrilmez, tekrarlayan numara doğru görünecek bir öneke kısaltılmaz. Native HTML/Markdown puan tablosunda yanlış sütun sayısı doldurulmaz. Geometri bulunmazsa yeniden hizalama istenir.

Yazılı toplam bağımsız okunur. Puanlar toplamdan türetilmez; toplam puanlara zorla eşitlenmez. Uyuşmazlık tüm puanları sarartmaz: yazılı toplam/kontrol ekranı uyarır. İki okumanın anlaşması doğruluk kanıtı değildir; GLM'nin kalibre edilmiş alan güven yüzdesi yoktur. GLM son okumadan sonra 30 dakika bellekte tutulur; kısa ders aralarında yeniden soğuk yükleme azalır, ancak bu süre boyunca model belleği kullanılır.

6 Ekim 2026'da tekrar kullanılan dört 5-soruluk gerçek fotoğraf testi: **20/20 soru puanı, 6/8 kimlik alanı, 2/4 yazılı toplam doğru**. İlk soğuk ölçüm ~65 sn; orijinal dosyalarda sıcak ölçümler ~1,7–2,5 sn (GPU kullanılarak, hazırlama dahil; telefon yakalama/yükleme hariç). Genel doğruluk, ofis CPU süresi veya sıfır hata garantisi değildir. Yerel raporlar `work/benchmark/glm-production-20261006-*.json`. Benchmark cevapları yalnız okuma bittikten sonra değerlendirmede kullanılır.

Ek soğuk başlangıç kontrolünde bir HTTPS okuması120sn sınırına takıldı; fotoğraf/satır korundu ve sıcak yeniden denemede1,7sn tamamlandı. Ağırlık hazırlığı ayrıldıktan sonraki kontrollü testte yaklaşık65sn hazırlık +84sn ilk tanıma ölçüldü. Bu nedenle toplam ilk sonuç beklemesi149sn civarında olabilir; sıcak2sn süresiyle karıştırılmamalıdır. Ek rapor: `work/cold-preparation-probe.json`.

## Doğrulama

```bash
npm test
npx tsc --noEmit
npm run lint
npm run build
```

Testler dinamik 1/3/7/12/30 soru/PÇ şema/geometrisi, Excel, literal sıfır/boşluk/toplam, kimlik alternatifleri/renkleri, atomik ortak kayıt, iki SQLite istemcisi, aynı hücre çatışması, model sırasında edit, iptal/lease recovery, aynı işlem kimliğiyle tekrar, native GLM ayrıştırma, EOT metadata kopyası ve telefon parola/kaynak denetimlerini kapsar. Fiziksel telefon/webcam, farklı ışık/perspektif ve diğer gerçek soru sayıları ayrıca sahada denenmelidir.

Gerçek GLM benchmark:

```bash
node reader/benchmark/glm-production.mjs --source-dir C:/fotograf-klasoru --output work/benchmark/yeni-sonuc.json
```

Dört örnek/etiket yerel `work/benchmark/cases.json` dosyasındadır; çıktı üzerine yazılmaz. `--prepared` önceki üst-form kopyalarını açıkça seçer.

Eski Qwen optimizasyonu açık model seçimiyle korunur: GPU bölgesel, CPU kompakt bütün üst tablo. `SCANEXAM_FAST_READING=off`, `SCANEXAM_REGION_READING=on/off` yalnız Qwen akışını etkiler. Tesseract karşılaştırma kodu varsayılan okuyucu değildir.

Kaynaklar: [GLM-OCR](https://github.com/zai-org/GLM-OCR), [GLM native Ollama](https://github.com/zai-org/GLM-OCR/blob/main/examples/ollama-deploy/README.md), [Ollama](https://github.com/ollama/ollama), [EOT düzeltmesi](https://github.com/ollama/ollama/pull/17195), [Qwen3.5-4B](https://huggingface.co/Qwen/Qwen3.5-4B). Paketlerin lisans dosyaları korunur.
