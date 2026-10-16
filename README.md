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

Üst çubuktaki **Açık / Koyu / Sistem** seçenekleri görünüm temasını değiştirir. Varsayılan Sistem, cihazın açık/koyu tercihine uyar; seçiminiz bu tarayıcıda saklanır. Sınav düzeni, canlı tarama ve sonuçlar bağlantıları ilgili bölüme götürür.

1. Ders, **1–30 soru** ve bağımsız **PÇ1–PÇ99** değerlerini ayarlayın. Aynı PÇ birden çok soruya atanabilir. İlk satırdan sonra soru sayısı kilitlenir. Basılı ders/PÇ okumasındaki fark sessizce ayarı değiştirmez.
2. Üst form ve **Puan / Not satırlarının tamamını** hizalayın. En az üç uygun kare ve 500 ms sabitlik gerekir; analiz aralığı 180 ms. Odak/analiz/kayıt ek süre getirir: gerçek telefon süresi garantisi değildir. Aynı sabitlik aralığının en iyi kenar/kontrast karesi seçilir; bu OCR güveni değildir. Renk korunur. Kırmızı/siyah kalem başarısı ışık, kontrast ve el yazısına bağlıdır.
3. **Yeşil tik = görüntü bu cihazın IndexedDB aktarım kuyruğuna kalıcı kaydedildi.** Aktarım/OCR arka plandadır; modeli beklemeden sonraki kâğıda geçin. Tutulan kâğıt tekrar yakalanmaz. Kâğıdı çıkarın veya üst üste değişimde “Sonraki kâğıda hazırla”yı kullanın; yanlış kullanım mükerrer kayıt yaratabilir.
4. Aktarılan fotoğraf/satır bilgisayarda atomik saklanır. Bilgisayar sırayla okur; telefon kapansa da **aktarılmış** işler sürer. Gizlenen sekmede kamera kapanır. Aktarılmamış görüntüler cihazda korunur ve tekrar denenir; aktarım bitene kadar sekmeyi açık tutun.
5. Aynı bilgisayara bağlı cihazlar yaklaşık bir saniyelik sorgularla aynı tabloyu görür. Farklı hücre düzenlemeleri birleşir; aynı hücrede eski değere göre yazma reddedilir. Model, okuma sırasında elle yapılan düzenlemeyi ezmez.
6. Sarı hücreyi kaynak fotoğrafla karşılaştırın; düzenleyin veya “Kontrol” ekranından onaylayın. Yeşil = şüphe bildirilmemesi veya kontrol/düzenleme; kalibre edilmiş güven yüzdesi değildir. İsim/numara önceden öğrenci listesi olmadığından her zaman kontrol ister.
7. **Excel'i indir** her zaman aktiftir; kontrol ve satır onayı isteğe bağlıdır. Bekleyen/hatalı okumalar, sarı hücreler, mükerrer numaralar veya bağlantının kopması indirmeyi engellemez. O anda bilinen ortak tablo indirilir; boş tabloda da sınav başlıkları oluşur. Eksik puanlar boş, geçersiz yazılar metin olarak korunur. Eksik/geçersiz soru içeren PÇ toplamı boş kalır; ortalamalar yalnız mevcut sayısal değerlerle hesaplanır. Soru/PÇ sütunları dinamik; öğrenci no baştaki sıfırlarını koruyan metindir.

Sınırlar: cihazda 20 aktarılmamış görüntü/120 MB; bilgisayarda 20 bekleyen-okunan iş/120 MB kaynak fotoğraf ve 2000 satır. Doluluk görünür hata verir, görüntü sessizce atılmaz. Tarama modelden hızlıysa kuyruk dolabilir. Ortak duraklatma/iptal bütün cihazlara uygulanır. Tek/çift tanıma süresi sınırı 120/240 saniyedir. GLM ağırlıkları uygulama açılışında öğrenci görüntüsü gönderilmeden hazırlanır (hazırlık sınırı 180 sn); model boşta bellekten çıkarılmışsa kuyruktaki kâğıt okunmadan bu hazırlık yeniden yapılır. Hazırlık okuma süresine dahil değildir; bu esnada kâğıtlar sırada saklanır, kullanıcı yeni kâğıt tarayabilir. Toplam ilk sonuç beklemesi hazırlık + tanıma + aktarım olduğundan daha uzun olabilir.

## Saklama ve doğruluk

Ortak tablo ve özgün fotoğraflar `work/shared/scanexam.sqlite` içinde SQLite WAL ile saklanır; klasörde kişisel veri vardır. Dev/telefon aynı veritabanını paylaşır. Yeniden başlatmada kalıcı kuyruk sürer, ölmüş lease yeniden alınır. Tek aktif sınav bütün bağlı cihazlara ortaktır; kullanıcı bazlı veya çoklu eşzamanlı sınav yönetimi değildir.

Excel'i düzenli indirin. Veri klasörünü güvenli tutun; yedek için sunucuları kapatıp SQLite ve varsa WAL/SHM dosyalarını birlikte saklayın. “Yeni sınav” onayı ortak tablo/fotoğrafları **bütün cihazlardan kaldırır**. Eski tarayıcı-only veriler otomatik içe alınmaz/silinmez. Özel mod/site verisi temizleme aktarılmamış görüntüleri kaybettirebilir. Bozuk kayıt sessizce boş sınavla değiştirilmez.

GLM gerçek çizgi geometrisinden isim/numara hücrelerini ayırır. İsim renk koruyan 2× ve etiketli hücreden, numara 2× etiketsiz ve etiketli hücreden okunur. Geçerli etiketsiz numara önceliklidir; bulunmazsa geçerli etiketli okuma kullanılır. Farklar alternatif/sarı uyarı olur. `Numarar` gibi baştaki basılı etiket okuması numaradan ayrılır; numaranın içindeki harfler değiştirilmez. İsimde rakam, numarada harf veya puan/toplamda geçersiz sayı varsa hücreye aktarılmaz: uygun alternatif yoksa hücre boş/sarı kalır, ham okuma alternatiflerde saklanır. Öğrenci listesiyle tamamlanmaz; harfler sayıya zorla çevrilmez, tekrarlayan numara doğru görünecek bir öneke kısaltılmaz. Native HTML/Markdown puan tablosunda yanlış sütun sayısı doldurulmaz. Geometri bulunmazsa yeniden hizalama istenir.

İsimler için bilgisayarda **zaten kuruluysa** `qwen3.5:4b` ile dil değerlendirmesi yapılır. Model ad/ikinci ad içindeki muhtemel OCR yazım hatalarını inceler; belirsiz yazıda yaygın Türkçe isim yorumu tercih edilir. Bu kullanıcının seçtiği tercihtir; nadir isimlerde hata riskini artırabilir. Dil değerlendirmesi ismi doğrudan değiştirmez: şüpheli durumda etiketsiz ve etiketli isim hücreleri yeniden okunur. Geçerli ilk isimde ancak tek kelime değişikliği ve ikinci kırpımın o kelimeyi desteklemesiyle, tam bir model okuması otomatik seçilir. İlk isim geçersizse iki yeni tam okuma uyuşmalıdır. Kelimeler birleştirilmez, `q/4 → ç` veya `Enre → Emre` gibi sabit dönüşüm tablosu yoktur. İlk sonuç/alternatifler korunur; isim düzeltmesi numara, puan ve toplamı değiştirmez. Model bulunmaz/hata verirse ilk GLM sonucu korunur; yeni model otomatik indirilmez. Ek kontrolün toplam sınırı 45 sn, kâğıt okumasının genel 120/240 sn sınırı içinde kalır; kullanıcı iptali uygulanır.

İsim kontrolü 2048 bağlam ve 8 GPU katmanı kullanır; GLM'nin GPU hızlandırması korunur. İki modelin birlikte bellekte kalmasına izin verilir; istekler sırayladır. Açılışta isim modeli önce hazırlanır, ardından GLM yüklenir; öğrenci görüntüsü gönderilmez. RTX 3050 Laptop 4 GB üzerinde tekrar kullanılan 15 geliştirme görüntüsünde sıcak okuma ortancası **21,06 sn → 3,52 sn**, yeni profilde aralık **2,78–7,15 sn** ölçüldü. Telefon yakalama/aktarma dahil değildir. Modeller bellekten çıkarılmışken ayrı ölçümde hazırlık **9,95 sn**, ilk kâğıt **8,79 sn**, sonraki iki kâğıt yaklaşık **6,88 sn** sürdü. Başlangıç hazırlığı ile sıcak ölçüm ayrı değerlendirilmelidir. İşlemci, RAM ve GPU değişince bu süreler değişir; ekran kartı olmayan ofis bilgisayarı için bu sonuçlar hız garantisi değildir.

Son iki canlı Nisa çekimi `Nisa koq/kog` yerine **Nisa Koç**, canlı Yunus çekimi `Yunus Enre Güngör` yerine **Yunus Emre Güngör** seçildi. 7 farklı kâğıdın 15 geliştirme görüntüsünde isim **12/15**, numara **11/15**, puan **72/75**, yazılı toplam **9/15** doğru; 8 görüntü tamamen doğruydu. Yavaş profilde puan 73/75 idi; hızlı tekrarın bir çekiminde `14 → 74` hatası görüldü. Bütün alanların doğruluğunun aynı kaldığı iddia edilmez. Rapor `work/benchmark/cedilla-20261008/report.md`; mevcut kullanıcı düzeltmeleri otomatik yeniden yazılmaz, yeni sürüm yeni okumalara uygulanır. `npm run phone` ayrı üretim derlemesi kullandığı için güncellemek için aktarım bittikten sonra `npm run phone:stop`, ardından `npm run phone` çalıştırın ve çıkan yeni adresi açın.

Yazılı toplam bağımsız okunur. Puanlar toplamdan türetilmez; toplam puanlara zorla eşitlenmez. Uyuşmazlık tüm puanları sarartmaz: yazılı toplam/kontrol ekranı uyarır. İki okumanın anlaşması doğruluk kanıtı değildir; GLM'nin kalibre edilmiş alan güven yüzdesi yoktur. GLM son okumadan sonra 30 dakika bellekte tutulur; kısa ders aralarında yeniden soğuk yükleme azalır, ancak bu süre boyunca model belleği kullanılır.

**100 puan sınırı:** puanların toplamı 100'ü aşıyorsa gerçek çizgi geometrisinden bulunan şüpheli Puan hücreleri en fazla iki soruda renkli/beyaz kenarlı görünümlerle ayrı okunur. Native okumalar farklıysa kurulu isim kontrol modeli aynı bellek profiliyle yalnız bu sayısal hücreyi ayrıca okur (8 sn sınır; bulunmaz/hata verirse ilk değerler korunur). Birbirini destekleyen literal okumalar ve 100'ü aşmayan yeni toplam olduğunda görsel puan değeri seçilir; eski değer alternatiflerde kalır. Soru sayısı veya soru başına eşit puan varsayılmaz; yazılı toplamdan eksik puan hesaplanmaz. Çelişki çözülmezse puanlar sarı kalır ve satır onayı için düzeltme gerekir. Kullanıcının tercihiyle Excel kontrolsüz de indirilebilir; 100'ü aşan değerler de tablodaki haliyle korunur, indirme onay oluşturmaz.

Toplam 100'ü aşmasa da 1/2/3/7 içeren geçerli puanlar en fazla altı hücrede renkli ve beyaz kenarlı kırpımlarla kontrol edilir. İlk okumadan farklı bir sayı için kurulu ikinci yerel modelin görsel desteği gerekir. Native kırpımlar ikinci modelin cevabını desteklemiyorsa 1/2, 3/7 veya 2/7 karışıklığı ikinci modelin iki ayrı kırpımda uyuşmasıyla çözülebilir. Sabit rakam değiştirme veya toplamdan cevap üretme uygulanmaz. Çelişkiler ve ilk değerler alanın alternatiflerinde korunur; yalnız biçim hatası olup farklı sayısal aday bulunmayan okumalar yeni uyarı üretmez. Ek kontrol kurulu model yokken ilk puanı korur; model indirmez.

Kontrol ekranı onayı engelleyen nedeni açıkça gösterir: eksik/geçersiz alanlar veya mükerrer numaranın bulunduğu satırlar. Bu doğrulama hataları sunucudan 400 yanıtıyla açıklanır; genel 500 mesajına dönüşmez. Ders/PÇ uyarıları tek özet kutusunda, teknik yeniden okuma açıklamaları kapalı “Okuma ayrıntıları” bölümünde gösterilir. Yazılı ve hesaplanan toplam farkı görünür kalır; onay bu farkı kabul edebilir ama 100'ü aşan puanı veya mükerrer numarayı geçemez.

13 Ekim 2026'da yenilenen `Desktop/scan_exam_testes` klasöründeki 10 fotoğrafla soru puanları tek tablo okumasında **48/50**, ek hücre kontrolüyle **50/50** doğru çıktı. Görsel olarak doğrulanan `13 → 17` ve `17 → 12` hataları çözüldü; yazılı toplamlar yeni akışta **10/10** doğruydu. Bu sonuç yalnız bu geliştirme setine aittir; kimlik/ders bilgisi hataları sürebilir. Ham sonuçlar ve değerlendirme `work/benchmark/digit-review-20261013` altında tutulur; mevcut ortak tablo bu deneylerle yeniden yazılmaz.

Ardışık taramalarda, kamera karesinin JPEG olarak saklanması ve farklı küçültme işlemleri ince tablo çizgilerinin seçilen konumunu birkaç piksel kaydırabilir. Puan tablosunun satır aralıkları kendi merkezinde ölçülür ve çizgi arama bandına uygun 6 piksel tolerans kullanılır. Kesik form, eksik Not satırı ve yanlış soru sütunu kontrolleri korunur. Boş kalan isimde iki ek okuma uyuşmazsa beyaz kenarlı üçüncü isim kırpımı denenir; en az iki tam görsel okumanın desteklediği isim seçilir. Üçüncü okuma başarısızsa ilk adaylar ve puanlar korunur. Hatalı satırın kontrol ekranı gerçek hata nedenini gösterir. 13 Ekim'deki aktif 11 taramanın yeniden okumasında geometri **10/11 → 11/11** oldu; Can Aslan'ın başarısız fotoğrafı okundu, boş Nisa ismi **Nisa Koç** olarak seçildi. Rapor `work/benchmark/capture-review-20261013/report.md` içindedir.

Son 10 gerçek telefon fotoğrafının izole yeniden okumasında Nisa'nın iki `74` hatası `14` olarak seçildi: puanlar **48/50 → 50/50**, kritik alanlar **72/80 → 74/80**, sıcak ortanca **3,91 sn**. Nisa çekimlerinde süre **4,06 / 5,37 sn**. Yazılı toplam hâlâ `89/87` okunuyor (doğru `81`); puanlardan üretilerek düzeltilmedi. İsim **7/10**, numara **9/10** doğru; ilk İbrahim numarası yanlış, tekrar çekimi doğru. 7 farklı kâğıdın bu 10 çekimi tekrar kullanılan geliştirme verisidir; bağımsız genel doğruluk değildir. `work/benchmark/score-limits-20261008` içindeki raporlar mevcut ortak tabloyu yeniden yazmadan oluşturuldu.

Tablodaki yazılı toplam boş, geçersiz veya puanların toplamıyla farklıysa yalnız Not hücresi renkli olarak yeniden okunur; bu da geçersizse ek kontrast görünümü denenir. Aritmetik yalnız ek kontrolü tetikler, cevap seçmez. Geçerli tablo toplamı, puanların toplamıyla uyuşmasa bile başka okumayla değiştirilmez. Yeniden okunan toplam kontrol ister; önceki literal okumalar alternatiflerde korunur. Ayrı rakamlar birleştirilmez, tekrarlayan rakamlar kısaltılmaz. Kontrast görünümü soluk/renkli çizgileri kaybedebileceği için genel görüntü yerine kullanılmaz.

8 Ekim'deki gerçek telefon taramalarıyla ikinci kontrol: yeni üç kâğıt fotoğraftan görsel etiketlerle **45/45 alan** doğru okundu. Genişletilmiş set 7 farklı kâğıda ait 12 görüntü içerir (yeniden çekimler ve eski kopyalar dahil); sonuçlar bağımsız 12 kâğıt doğruluğu sayılmaz. Can Aslan'daki `Numarar` etiketi ayrıldı; Yunus Emre Güngör'ün bir çekimindeki numara seçimi düzeldi. Nisa kâğıdında kimlik/toplam, bazı çekimlerde rakamdan-rakama puan hataları sürer; alan kuralları bunların hepsini yakalayamaz. İsimdeki `K04` artık sonuç değeri olarak kullanılmaz, kontrol alternatifinde kalır. Rapor ve görseller Git dışında `work/benchmark/capture-errors-20261008` içinde.

Kamera 2560×1440 çözünürlüğü tercih olarak ister; cihaz daha düşük çözünürlük sunabilir. Yakalama üst sınırı 1600 piksel, geometri analizi 800 piksel kalır. Dikey telefonda kısa kenar kaynak ayrıntısını sınırlayabildiğinden bu tercih yeni çekimlere yöneliktir; mevcut 1080×648 fotoğraflara ayrıntı eklemez. Fiziksel telefonda yeni çözünürlüğün başarı/süre etkisi henüz ölçülmedi.

8 Ekim 2026'da aynı dört fotoğrafın saklanan üst-form kopyalarıyla kontrollü karşılaştırma: soru puanları **20/20 → 20/20**, kimlik **6/8 → 6/8**, yazılı toplam **2/4 → 3/4**; kritik alanlar **28/32 → 29/32**, tamamen doğru kâğıt **2/4 → 3/4**. Bunlar geliştirmede tekrar kullanılan örneklerdir; genel doğruluk veya yeni kâğıt başarısı değildir. Farklı filtreler ve ikinci yerel model bazı doğru alanları bozduğu için genel varsayılan yapılmadı. 1/3/7/12/30 soru geometrisi, ayrıştırma, yeniden okuma ve değerlendirme testleri geçer; farklı soru sayılı gerçek fotoğraflar henüz ölçülmedi. Yerel ayrıntılar `work/benchmark/accuracy-20261008.md` içinde.

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

Yeni etiketli set için `--cases C:/fotograf-klasoru/cases.json` kullanılır. Her kâğıdın soru sayısı kendi `expected.scores` uzunluğundan alınır (1–30); PÇ etiketleri aynı uzunlukta olmalıdır. Değerlendirme S10–S30 dahil bütün alanları sayar. Model hazırlığı ayrıca `modelPreparationMs` olarak ölçülür; soğuk yüklemeden sonraki ilk okuma sıcak süre özetinden çıkarılır. Eski toplam akışını aynı model koşullarında karşılaştırmak için yalnız benchmark'ta `--disable-total-retry` kullanılabilir.

Eski Qwen optimizasyonu açık model seçimiyle korunur: GPU bölgesel, CPU kompakt bütün üst tablo. `SCANEXAM_FAST_READING=off`, `SCANEXAM_REGION_READING=on/off` yalnız Qwen akışını etkiler. Tesseract karşılaştırma kodu varsayılan okuyucu değildir.

Kaynaklar: [GLM-OCR](https://github.com/zai-org/GLM-OCR), [GLM native Ollama](https://github.com/zai-org/GLM-OCR/blob/main/examples/ollama-deploy/README.md), [Ollama](https://github.com/ollama/ollama), [EOT düzeltmesi](https://github.com/ollama/ollama/pull/17195), [Qwen3.5-4B](https://huggingface.co/Qwen/Qwen3.5-4B). Paketlerin lisans dosyaları korunur.
