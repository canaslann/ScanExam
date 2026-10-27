# Scan Exam — Sınav Tarayıcı

Telefon, webcam veya galeri fotoğraflarındaki sınav üst formunu okur; öğrenci bilgileri, soru puanları ve yazılı toplamı ortak, düzenlenebilir tabloda gösterir. Sonuçlar Excel'e aktarılır. Okuma bilgisayarda yerel çalışır.

Arayüzde iki ana okuyucu seçilebilir: **GLM-OCR** ve **Qwen3.5-9B Q8**. Soru sayısı **1–30**, her sorunun PÇ eşleşmesi **PÇ1–PÇ99** arasında dinamiktir. Aynı PÇ birden fazla soruya atanabilir.

## Gereksinimler

- Otomatik model kurulumu için **Windows x64**.
- **Node.js 24 önerilir**; desteklenen en düşük sürüm `22.18.0`. Node.js ile gelen npm ve Git.
- İlk bağımlılık, motor ve model indirmeleri için internet bağlantısı.
- Kamera için güncel Chrome, Edge veya Safari; telefonda güvenilir HTTPS gerekir.
- Bütün modelleri kurarken indirmeler, açılmış motor ve model kopyaları için yaklaşık **25–30 GB boş disk alanı** ayırın.

Qwen için hedef sistem **RTX 3090 / 24 GB VRAM ve 32 GB RAM**. Daha küçük GPU'da kullanılabilir VRAM'e sığan katmanlar GPU'da, kalanlar RAM/CPU'da çalışabilir; toplam belleğin yeterli olması gerekir ve okuma yavaşlayabilir. GPU ve RAM bellekleri tek bir eşdeğer hızlı bellek havuzu değildir. GLM-OCR daha hafif seçenektir.

## Yeni bilgisayarda kurulum — iki model birlikte

PowerShell'de:

```powershell
git clone https://github.com/canaslann/ScanExam.git
cd ScanExam
npm ci
npm run reader:setup:all
npm run dev
```

Bilgisayarda **http://localhost:5173** adresini açın. Canlı tarama bölümündeki **Okuma modeli** alanından GLM-OCR veya Qwen3.5-9B seçin.

`reader:setup:all` şunları hazırlar:

| Bileşen | Görevi | Yaklaşık indirme |
|---|---|---:|
| Ollama `v0.35.0` | Proje içindeki yerel motor | 1,46 GB arşiv |
| `glm-ocr-eot:q8_0` | Varsayılan GLM-OCR okuyucu | 1,59 GB kaynak paket; ek yerel EOT kopyası |
| `qwen3.5:4b` | Mevcut GLM akışının yardımcı kimlik/alan okuyucusu | 3–4 GB |
| `qwen3.5:9b-q8_0` | Bağımsız ikinci ana okuyucu | 10 GB |

4B yardımcı model arayüzde üçüncü bir ana seçenek oluşturmaz. Qwen3.5-9B seçeneği tüm alanları kendisi okur; GLM veya 4B yardımcı modeli çağırmaz.

Motor ve modeller `work/reader/` altında tutulur. Global Ollama kurulması veya ekran kartı/CPU paylaşımının elle ayarlanması gerekmez. Motor arşivi SHA-256 ile doğrulanır. GLM kurulumu sabit SHA-256 kaynak sürümünü kullanır; EOT kopyasında yalnız bitiş işareti metadata'sı eklenir, tensor verileri doğrulanır. Kurulu yardımcı/Qwen modelleri yeniden indirilmez; mevcut GLM alias'ı doğrulanır. Model kurulumu sınav fotoğraflarını göndermez.

İlk model yüklemesi okuma öncesinde ek bekleme oluşturabilir. Uygulamanın açılması tek başına modelin kurulu olduğu anlamına gelmez; seçili okuyucunun durumunu **Okuyucuyu kontrol et** ile görün.

## Modelleri ayrı kurma

Daha hafif başlangıç için:

```powershell
npm ci
npm run reader:setup
npm run dev
```

Bu komut yalnız mevcut GLM-OCR kurulumunu yapar. Mevcut GLM kimlik desteğini eklemek için:

```powershell
npm run reader:setup:identity
```

Bağımsız Qwen seçeneğini sonradan eklemek için:

```powershell
npm run reader:setup:qwen
```

Modeli **arayüzden seçin**; iki seçenek arasında geçmek için ortam değişkeni ayarlamanız gerekmez. Eski bir kurulumda `SCANEXAM_MODEL` elle ayarlanmışsa varsayılan GLM yolunu etkileyebilir; standart kurulumda bu değişkeni ayarlamayın.

## Üretim sürümünü çalıştırma

```powershell
npm run build
npm start
```

Üretim uygulaması varsayılan olarak **http://localhost:3000** adresindedir. Bilgisayar, yerel okuyucu ve Node.js uygulaması açık kalmalıdır. Statik dosya barındırma tek başına yeterli değildir.

Geliştirme sunucusunda kullanıcı girişi yoktur; doğrudan geliştirme portunu internete açmayın. Telefon paylaşımı için aşağıdaki parolalı HTTPS akışını kullanın.

## Telefonda kamera kullanma

Telefon kamerası güvenilir HTTPS ister. `http://BILGISAYAR_IP:5173` adresi bunun için yeterli değildir.

Fotoğraf, öğrenci bilgileri ve sonuç trafiğinin Cloudflare üzerinden geçmesine izin verilen geçici kullanımda:

```powershell
npm run phone
```

Bu komut uygulamayı derler; proje içindeki doğrulanmış `cloudflared` paketini ilk seferde indirir ve geçici HTTPS adresini terminalde gösterir. Telefonu bu adrese bağlayın. Model indirmez; modelleri önce yukarıdaki kurulum komutlarıyla hazırlayın.

Varsayılan geçici kullanıcı adı ve parola **scanexam**. Gerçek kullanımda başlatmadan önce daha güçlü bir parola belirleyin:

```powershell
$env:SCANEXAM_PHONE_PASSWORD = 'buraya-en-az-8-karakterli-guclu-bir-parola-yazin'
npm run phone
```

Kullanıcı adı `scanexam` kalır. Bağlantı bilgileri yerel `work/phone/telefon-baglantisi.txt` dosyasına yazılır. Adres/parola geçidi tüm uygulama/API isteklerine uygulanır; model portu internete açılmaz.

Kapatmak için:

```powershell
npm run phone:stop
```

Bu komut telefon uygulaması ve tüneli kapatır. Tekrar açıldığında HTTPS adresi değişebilir. Bilgisayara aktarılmış tablo ve fotoğraflar korunur; eski adreste cihazda kalan aktarılmamış görüntüler yeni origin'e otomatik taşınmaz. Quick Tunnel kalıcı kurumsal dağıtım değildir. Kurumun kendi HTTPS vekili de kullanılabilir.

## Tarama ve sonuçlar

1. Ders, soru sayısı ve her sorunun PÇ eşleşmesini ayarlayın. İlk kayıttan sonra soru sayısı korunur; farklı sayıda soru için yeni sınav açın.
2. Ana okuyucuyu seçin. Seçim bu cihazdan **yeni eklenen fotoğraflara** uygulanır; her fotoğrafla birlikte kaydedilir. Kuyruktaki işler ve yeniden okumalar kendi modelini korur.
3. Görüntü ekleme yöntemini seçin:
   - **Mevcut otomatik tarama:** en az üç uygun kare ve 500 ms sabitlik.
   - **Seri fotoğraf çekimi:** üst formu merkez 5:3 kadraja alıp düğmeyle kaydedin.
   - **Hızlı otomatik yakalama:** ilk uygun geometri/netlik karesinde yakalar; aynı kâğıt çıkarılana kadar tekrar çekmez.
   - **Galeriden toplu yükle:** üst form veya tam sayfa fotoğraflarını sırayla aktarır.
4. Kamera modlarında isim/numara ve Puan/Not satırlarının tamamını kadraja alın. Galeri tam sayfa kabul eder. Kamera görüntüsü en fazla 1600 piksel; galeri uzun kenarı en fazla 2400 piksel olarak hazırlanır.
5. Yeşil çekim onayı görüntünün **o cihazda kalıcı aktarım kuyruğuna kaydedildiğini** belirtir. Bilgisayara aktarım ve okuma ayrı aşamalardır; sonraki kâğıda geçebilirsiniz.
6. Sarı hücreleri kaynak fotoğrafla karşılaştırın. Kontrol penceresinden düzeltin/onaylayın. İsim ve numara fotoğrafla kontrol ister; renkler ölçülmüş doğruluk yüzdesi değildir.
7. **Excel'i indir** o andaki tabloyu alır. Eksik, hatalı veya onaylanmamış kayıtlar indirmeyi engellemez. Eksik puanlar boş, geçersiz metinler metin olarak korunur; numaraların baştaki sıfırları kaybolmaz.

Aynı bilgisayara bağlı cihazlar ortak tabloyu görür. Sunucu fotoğrafları FIFO sırasıyla okur; bilgisayara aktarılmış işler telefon kapansa da sürer. Model sonucu, okuma sırasında elle yapılan dolu hücre düzeltmelerini ezmez. Tamamlanmış kayıtlarda **Yeniden oku** aynı fotoğrafı yeniden sıraya alır.

İsteğe bağlı Excel öğrenci listesi için `.xlsx` veya `.xls` yükleyebilirsiniz. Öğrenci numarası ve ad-soyad ya da ayrı ad/soyad sütunları seçilir; en fazla 5000 öğrenci desteklenir. Liste ortak sınava aittir. Başında sıfır olan numaraları Excel'de metin olarak saklayın. Liste karşılaştırması ek model isteği göndermez; belirsiz eşleşmeler kontrol ister.

## Okuyucular ve süreler

| Özellik | GLM-OCR | Qwen3.5-9B Q8 |
|---|---|---|
| Ana model | `glm-ocr-eot:q8_0` | `qwen3.5:9b-q8_0` |
| Kullanım | Mevcut hızlı OCR akışı; tek/çift kontrol | Bağımsız okuma ve aynı Qwen ile yakın alan karşılaştırması |
| Soru sayısı | 1–30 | 1–30 |
| Model hazırlığı | En fazla 180 sn; okuma süresinden ayrı | En fazla 180 sn; okuma süresinden ayrı |
| Görüntü hazırlığı + ilk okuma | En fazla 120 sn; normal hedef 20 sn altı | En fazla 120 sn |
| Ek Qwen yakın kontrolü | Uygulanmaz | Ayrıca en fazla 60 sn |

GLM-OCR'nin mevcut okuma istemleri, GPU/CPU ayarları, kırpma akışı ve süre sınırları Qwen eklenirken değiştirilmedi.

Qwen ilk tam görüntü okumasını korur. Öğrenci numarası yakın görünümden okunur. Sayısal alan eksik, belirsiz veya yazılı toplamla tutarsızsa bütün soru hücrelerinin renkli küçük ve dikey büyük görünümleri karşılaştırılır. Farklı yeni bir değer ancak iki yakın okuma uyuşursa seçilir; ilk değerler alternatiflerde kalır ve değişen alanlar kontrol ister. Uyuşmazlıkta ilk değer korunur. Geometri doğrulanamazsa tam görüntü sonucu korunur. Ek kontrol başarısız olursa tamamlanmış ilk okuma kaybolmaz; kullanıcı iptali yine uygulanır.

Numara sabit 11 haneye zorlanmaz. Puanlar toplamdan türetilmez, yazılı toplam hesaplanan toplamla değiştirilmez; sabit rakam değiştirme veya eşit soru puanı varsayımı yoktur. Toplam uyuşmazlığı kontrolü tetikler; görsel kanıtın yerini tutmaz. Çözülemeyen 100 puan aşımı ve mükerrer numaralar satır onayını engeller.

Süreler modelin bellekte olmasına, GPU/CPU dağılımına, soru sayısına, fotoğrafa ve ek kontrollere bağlıdır. Model hazırlığı, aktarım ve FIFO beklemesi tanıma süresinden ayrıdır. Modeller son kullanımdan sonra 30 dakika bellekte tutulabilir.

27 Ekim 2026 geliştirme karşılaştırmasında, tekrar kullanılan 11 fotoğraftaki ilk sonuçlara yeni Qwen kontrolleri uygulandı: puanlar **52/55 → 55/55**, tam eşleşen öğrenci numaraları **7/11 → 9/11**, yazılı toplamlar **11/11 → 11/11**. İki çekim aynı kâğıda aittir. Bir zor örnek yeni okuyucuyla baştan sona ayrıca denendi ve RTX 3050 Laptop 4 GB üzerinde yaklaşık **114 sn** sürdü. Bu küçük geliştirme seti genel doğruluk veya 3090 hız garantisi değildir; kalan numaralar elle kontrol gerektirir. Gerçek öğrenci verileri ve yerel raporlar Git'e eklenmez.

## Güncelleme

Bekleyen cihaz aktarımlarını tamamlayın. Çalışan uygulamayı kapattıktan sonra:

```powershell
git pull --ff-only
npm ci
npm run reader:setup:all
```

Modeller zaten kuruluysa tekrar indirilmez. Geliştirme için `npm run dev`; üretim için `npm run build` ve `npm start` kullanın. Açık telefon üretim süreci kaynak kodu kendiliğinden yenilemez: aktarımlar tamamlandıktan sonra `npm run phone:stop`, ardından `npm run phone` çalıştırıp yeni HTTPS adresini açın.

## Veri ve sınırlar

- Ortak tablo, fotoğraflar ve kalıcı kuyruk: `work/shared/scanexam.sqlite` ve SQLite WAL/SHM dosyaları.
- Cihazda 20 aktarılmamış görüntü / 120 MB; bilgisayarda 20 bekleyen-okunan iş / 120 MB fotoğraf ve 2000 satır sınırı.
- **Yeni sınav**, onaydan sonra bütün bağlı cihazların ortak tablo ve fotoğraflarını kaldırır.
- Yedek için uygulamaları kapatın; SQLite ve varsa WAL/SHM dosyalarını birlikte saklayın. Excel'i düzenli dışa aktarın.
- Tarayıcı verisini temizlemek aktarılmamış görüntüleri kaybettirebilir. Aktarım bitene kadar telefon sekmesini açık tutun.
- Tek aktif sınav ortaktır; kullanıcı bazlı veya çoklu eşzamanlı sınav yönetimi yoktur.
- `work/`, model dosyaları, fotoğraflar, test etiketleri, veritabanı ve telefon parolaları depoya dahil değildir.

## Sorun giderme

| Durum | Kontrol |
|---|---|
| `node` / `npm` bulunamıyor | Node.js 24 kurun, PowerShell'i yeniden açın; `node --version` ve `npm --version` çalıştırın. |
| Okuma modeli kurulu değil | Seçili modele göre `reader:setup`, `reader:setup:qwen` veya `reader:setup:all` çalıştırın. |
| İsim/numara desteği eksik | GLM yardımcı modeli için `npm run reader:setup:identity`; kaynak fotoğrafla kontrol edin. |
| Motor bulunamadı / bağlantı kurulamadı | Kurulumu tamamlayıp uygulamayı yeniden açın; `work/reader/service.log` dosyasını inceleyin. Varsayılan motor adresi `http://127.0.0.1:11435`. |
| İlk okuma yavaş | İlk model yüklemesini ve CPU/RAM paylaşımını hesaba katın. 4 GB VRAM'de 9B modelin tamamı GPU'ya sığmaz. |
| Telefonda kamera açılmıyor | Güvenilir HTTPS, güncel normal tarayıcı ve kamera izni kullanın. |
| Telefon eski sürümü gösteriyor | Aktarımı tamamlayıp `phone:stop` ve `phone` ile yeniden başlatın; yeni adresi açın. |
| Sarı hücre / toplam farkı | Kaynak fotoğrafı kontrol edin. İki model okumasının uyuşması tek başına doğruluk kanıtı değildir. |

## İleri ayarlar

Standart kurulumda ortam değişkeni gerekmez. Gerekirse PowerShell'de uygulamayı başlatmadan önce ayarlayın:

| Değişken | Varsayılan / açıklama |
|---|---|
| `SCANEXAM_READER_URL` | `http://127.0.0.1:11435`; yalnız HTTP loopback adresleri kabul edilir. |
| `SCANEXAM_READER_THREADS` | GLM tarafında varsayılan 4 iş parçacığı; isteğe bağlı 1–64. |
| `SCANEXAM_DATA_DIR` | `work/shared`; dev ve telefon aynı veri dizinini kullanmalıdır. |
| `SCANEXAM_PHONE_PASSWORD` | Geçici varsayılan `scanexam`; gerçek kullanımda değiştirin. |
| `SCANEXAM_HTTPS_CERT`, `SCANEXAM_HTTPS_KEY` | Doğrudan geliştirme HTTPS'i için birlikte verilir; telefon sertifikaya güvenmelidir. |
| `SCANEXAM_PUBLIC_ORIGIN` | Kendi üretim HTTPS vekilinizin tam origin'i; özgün Host korunmalıdır. |
| `SCANEXAM_MODEL` | Eski GLM yolunun sunucu düzeyi model ayarı; varsayılan `glm-ocr-eot:q8_0`. Normal iki-model seçimi için kullanmayın. |

## Geliştirme ve doğrulama

```powershell
npm test
npx tsc --noEmit
npm run lint
npm run build
```

Testler dinamik soru/PÇ şeması ve geometrisi, Qwen karşılaştırmaları, literal sıfırlar/boşlar/toplamlar, Excel, kalıcı ortak kuyruk, öğretmen düzenlemeleri, iptal ve telefon parola/kaynak denetimlerini kapsar. 1, 3, 7, 12 ve 30 soru geometrisi test edilir; farklı soru sayılı gerçek fotoğraflar ayrıca sahada denenmelidir.

Yerel benchmark araçları: [reader/benchmark/README.md](reader/benchmark/README.md). Gerçek fotoğrafları, öğrenci numaralarını veya beklenen cevapları kaynak koda eklemeyin. Yerel etiket/raporları `work/benchmark/` altında tutun.

Kaynaklar: [GLM-OCR](https://github.com/zai-org/GLM-OCR), [Ollama](https://github.com/ollama/ollama), [Qwen3.5-9B](https://huggingface.co/Qwen/Qwen3.5-9B). Model ve motor paketlerinin lisansları kendi dağıtımlarında korunur.
