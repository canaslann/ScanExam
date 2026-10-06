# Yerel OCR karşılaştırması

Bu araçlar deney içindir; uygulamanın modelini, GPU ayarını veya 120 saniyelik zaman aşımını değiştirmez. İstekler yalnızca localhost'a gider. Model dosyaları resmî Ollama/PaddlePaddle kaynaklarından indirilir, SHA-256 kontrolünden sonra kurulurlar.

## Hazırlık

Node 22.18+ ve projenin bağımlılıkları gerekir. `npm run reader:setup` mevcut okuyucu motorunu kurar. Benchmark, `work/reader/v0.35.0` motorunu ve mevcut model önbelleğini kullanır. Bağımsız portları 11436 (Ollama) ve 11437 (Paddle) boş olmalıdır; başka bir servis varsa durdurulmaz.

Referans dosyası `work/benchmark/cases.json` yerel tutulur. Fotoğraf yollarını, doğrulanmış alanları ve gerektiğinde elle işaretlenmiş bölge koordinatlarını içerir. Örnek biçim `cases.example.json` dosyasındadır. Gerçek öğrenci bilgilerini Git'e eklemeyin. Beklenen cevaplar modele gönderilmez.

```powershell
node reader/benchmark/prepare.mjs
node reader/benchmark/prepare.mjs --width 1024
node reader/benchmark/prepare.mjs --region-scale 2
node reader/benchmark/setup.mjs glm-ocr:q8_0 qwen2.5vl:3b qwen3.5:2b
node reader/benchmark/setup.mjs paddle
```

Normal Ollama indirmesi bağlantı nedeniyle başarısızsa aynı resmî registry/manifest/digest/önbellek düzenini kullanan alternatif:

```powershell
node reader/benchmark/download-ollama.mjs glm-ocr:q8_0 qwen2.5vl:3b qwen3.5:2b
```

İndirmeler kısmi dosyalardan devam eder. Büyük bağlantılar kopuyorsa küçük aralıklar denenebilir; her aralığın HTTP 206, Content-Range ve boyut bilgisi, kurulumdan önce de bütün dosyanın SHA-256 değeri doğrulanır:

```powershell
$env:BENCHMARK_RANGE_DOWNLOAD = '1'
node reader/benchmark/setup.mjs paddle
node reader/benchmark/download-ollama.mjs glm-ocr:q8_0
```

Aynı modeli/dosyayı iki ayrı indirme sürecinde eşzamanlı çalıştırmayın. İndirme sırasında yalnızca model dosyaları alınır; sınav fotoğrafları yüklenmez.

## Ölçüm

GPU kullanılabiliyorsa kullanan profil varsayılandır. CPU profili yalnızca benchmark'ın alt süreçlerini etkiler; sistem GPU'sunu kapatmaz. Modeller sıralı denenir; eşzamanlı iki benchmark başlatmayın.

```powershell
node reader/benchmark/run.mjs --device auto --output work/benchmark/all-auto.json
node reader/benchmark/run.mjs --device cpu --threads 4 --output work/benchmark/all-cpu.json

# Tek model / görüntü boyutu deneyi
node reader/benchmark/run.mjs --device cpu --models qwen3.5:4b --cases work/benchmark/prepared-cases-1024.json --output work/benchmark/qwen35-4b-cpu-1024.json

node reader/benchmark/report.mjs work/benchmark/all-auto.json work/benchmark/all-cpu.json
npm test
```

Önceden aynı adlı sonuç dosyası varsa `--output` için yeni bir ad seçin; sonuçlar her okumadan sonra bu dosyaya yazılır. Ham cevaplar kişisel veri içerebilir ve Git tarafından dışlanan `work/benchmark` altında tutulmalıdır.

Qwen varsayılan olarak uygulamadaki JSON sözleşmesini ve prompt'u kullanır. `--qwen-mode regions` aynı üç bölgeyi daha küçük JSON sözleşmeleriyle okur. GLM-OCR varsayılan olarak yerel `/api/generate` ve üreticinin önerdiği boş JSON nesnesi biçimindeki çıkarım istemini kullanır (`top-native-json`). Eski uygulama istemiyle kontrol için `--glm-mode contract`, yerel OCR görevleriyle aynı üç bölgeyi okumak için `--glm-mode regions` kullanılabilir. Paddle kendi `OCR:` / `Table Recognition:` görevleriyle üç bölgeyi okur. Bu bölgeler elle işaretlidir; süre otomatik hizalama/bölge bulmayı içermez. Paddle'ın auto profili paketlenmiş NVIDIA CUDA backend'ini kullanır; diğer GPU türleri için hazır destek iddiası yoktur. Gerçek offload sunucu günlüğünden kontrol edilmelidir.

Paddle'ın OTSL tablo çıktısı hücre konumları korunarak ayrıştırılır. Boş hücreler kaydırılmaz; yazılı toplam puanların toplamından hesaplanmaz. `--region-scale 2` yalnız bölge resimlerini iki kat büyütür; bu yeni görüntü ayrıntısı üretmez ve her modelde iyileşme garantisi değildir. Bu profil için `--cases work/benchmark/prepared-cases-regions-x2.json` kullanılır.

## GLM'nin ayrı bitiş işareti deneyi

Bu oturumda resmî GLM Q8 GGUF dosyasındaki eksik `tokenizer.ggml.eot_token_id` yüzünden yerel OCR cevabı bitmeyip çıktı sınırına kadar tekrarlandı. [Ollama düzeltmesi](https://github.com/ollama/ollama/pull/17195) esas alınarak yalnız bir test kopyasına `<|user|>` token kimliği eklendi. Özgün dosya korunur; tüm 527 tensörün türü, boyutu ve veri SHA-256 değerlerinin aynı olduğu doğrulanır. Bu bir model eğitimi veya ağırlık değişimi değildir. Test alias'ı `glm-ocr-eot:q8_0`, provenance kaydı `work/benchmark/models/glm-eot/provenance.json` dosyasıdır.

Python ve `gguf==0.19.0` (NumPy/tqdm/PyYAML bağımlılıklarıyla) gerekir. İsteğe bağlı yerel kurulum ve deney:

```powershell
python -m pip install --target work/benchmark/python-deps gguf==0.19.0
node reader/benchmark/setup-glm-eot.mjs
node reader/benchmark/run.mjs --device auto --models glm-ocr-eot:q8_0 --glm-mode regions --output work/benchmark/glm-ocr-eot-regions-auto.json
node reader/benchmark/run.mjs --device cpu --models glm-ocr-eot:q8_0 --glm-mode regions --output work/benchmark/glm-ocr-eot-regions-cpu.json
```

Gerekirse Python yolunu `BENCHMARK_PYTHON` ile verin. Kopya ve Ollama alias'ı ek disk alanı kullanır; özgün model yeniden indirilmez. Bu işaret düzeltmesini taşımayan GLM'nin başarısız bölgesel testi aday doğruluğu olarak sıralanmamalıdır; tanı kaydı olarak korunur.

## Sonuçların anlamı

- Her kâğıtta 5 soru puanı, yazılı toplam, ad ve öğrenci numarası ayrı değerlendirilir: 8 el yazısı alanı. Ders kodu/adı ve 5 PÇ eşleşmesi ayrıca 7 basılı alandır.
- Türkçe harfler ve numaranın başındaki sıfırlar korunur. Puanlar toplanarak yazılı toplam veya belirsiz puan düzeltilmez. Başarısız istekler doğruluk paydasında kalır.
- İlk istek ve sonraki sıcak okumalar ayrıdır. Ollama ilk isteğinde model yüklemeyi içerir; Paddle modeli sunucu başlangıcında yükler, bu süre `setupMs` alanındadır ve istek sürelerine dahil değildir. Toplam kullanıcı beklemesini karşılaştırırken bu farkı hesaba katın.
- İsteklere 600 saniye tanınması bir uygulama değişikliği değil, 120 saniyeyi aşan çalışmaları ölçebilmek içindir. Raporun 120 saniye sütunu istek sürelerini gösterir.
- Windows bellek örnekleyicisi süreç ağacının çalışma kümesini ve özel bellek miktarını ölçer. Bunlar minimum RAM gereksinimi değildir. Paylaşılan sayfalar birden fazla sayılabilir. Örnekleyici erişemiyorsa sıfır örnek, ölçümün eksik olduğu anlamına gelir.
- 4 kâğıt bir başlangıç testidir; genel doğruluk, tüm ofis bilgisayarları veya 8 GB RAM için yeterlilik kanıtı değildir. Dört iş parçacığı daha eski bir CPU'yu taklit etmez. Son seçim için farklı el yazıları ve gerçek düşük donanım üzerinde ayrıca test gerekir.
- Videoda aynı kâğıdın keskin ve farklı karelerini seçip alan bazında karşılaştırmak denenebilir. Aynı fotoğrafı deterministik modelle tekrarlamak yeni kanıt sağlamaz. Birkaç okumanın anlaşması da doğruluk garantisi değildir. Bu veri setinde video bulunmadığından video kazancı ölçülmüş değildir.

## Bu oturumdaki durum

GLM-OCR ve PaddleOCR-VL-1.5 indirmeleri tamamlandı. CPU/GPU deneyleri, Qwen3.5-4B referansı ve bölge büyütme denemeleri `work/benchmark/comparison.md` içindedir. Karar özeti `work/benchmark/decision.md` dosyasıdır. İlk Paddle kaydının OTSL ayrıştırıcısı eksikti; düzeltilmiş ayrıştırıcıyla testler yeniden çalıştırıldı ve yalnız bu kayıtlar karşılaştırmaya alındı. Ham eski kayıtlar tanı için korunur.

İlk aşamada yalnız GLM ve Paddle indirildi/denendi. Kullanıcının 2026-10-06 onayıyla Qwen3.5-2B'nin resmî Ollama Q8_0 paketi de indirildi ve hem bölgesel JSON hem tek üst tablo sözleşmesiyle GPU/CPU deneylerine alındı. Güncel model kararı `work/benchmark/decision-2026-10-06.md` dosyasıdır. Qwen2.5-VL-3B ertelendi; bu model için ölçüm yoktur. Uygulamanın üretim modeli ve 120 saniyelik zaman aşımı değiştirilmedi.

## Uygulama hızlandırma ölçümü

`production.mjs`, uygulamanın gerçek veri doğrulama, istem, hata/kalite geri dönüşü ve çift kontrol akışını çalıştırır. Varsayılan `--strategy adaptive`, gerçek `/api/ps` GPU belleğine göre CPU'da bütün tabloyu koruyan boş alan kırpmasını, GPU'da bölgesel okumayı seçer. Soğuk model görüntüsüz yüklenir; CPU/GPU kullanımı doğrulanamazsa özgün akış korunur. `--strategy auto` yalnız bölgesel deneyi zorlar; `compact` bütün tablo kırpmasını, `top` eski akışı zorlar.

Bölgeler elle verilmez: `lib/paper-regions.ts` yalnız piksel ve tablo çizgilerinden şablonu doğrular. Öğrenci kırpımı üst form bağlamını korur. GPU'da sayısal bölge önce okunur; eksik/belirsiz/tutarsız puan, yazılı toplam veya PÇ eşleşmesi varsa diğer iki bölgeye zaman harcamadan özgün tam tablo istemine dönülür. CPU'da Not satırı altına pay bırakılır, üst tablonun tamamı ve özgün istem aynen korunur. Hiçbir değer aritmetikle düzeltilmez.

```powershell
node reader/benchmark/production.mjs --device cpu --strategy top --output work/benchmark/production-baseline-cpu.json
node reader/benchmark/production.mjs --device cpu --output work/benchmark/production-regions-cpu.json
node reader/benchmark/production.mjs --device auto --output work/benchmark/production-regions-gpu.json
node reader/benchmark/production.mjs --device auto --check-mode double --limit 1 --output work/benchmark/production-double-one.json
node reader/benchmark/production.mjs --device auto --check-mode double --case-id paper-4 --output work/benchmark/production-double-fallback.json
```

Burada 120/240 saniyelik uygulama son tarihleri geçerlidir (eski model benchmark'ındaki 600 saniye değil). Süre otomatik bölge bulma/kırpma ve bütün model/geri dönüş isteklerini içerir. CLI, hazırlanmış JPEG üzerinde sharp kullanır; tarayıcı özgün fotoğrafın canvas pikselini kullanır. Tarayıcıdaki JPEG kodlaması bit düzeyinde aynı değildir; bu ölçümler telefon yüklemesi/UI ve özgün fotoğraf çözümlemesini içermez. `--limit 1` dört kâğıdın doğruluk testi sayılmaz. İki alanın birlikte yanlış ama toplamının tutarlı olması geri dönüş tarafından kesin yakalanamaz; öğretmen kontrolü zorunlu kalır.

İlk dar öğrenci kırpımı ve kısaltılmış sayısal tam tablo istemi doğruluk kaybı gösterdiği için reddedildi. Son bağlamlı bölgesel yöntem CPU'da, bütün tablo kırpması ise GPU'da öğrenci numarası gerilemesi gösterdi; ikisi tek başına genel varsayılan olarak kabul edilmedi. `production-auto-*` ve `production-guarded-*` kayıtları yalnız tanıdır; kabul edilen hızlandırma olarak sıralanmamalıdır. Son doğrulama özeti `work/benchmark/optimization-2026-10-06.md` içindedir.

Qwen3.5-2B deneyinin tekrar çalıştırılması (sonuçlar mevcutsa yeni çıktı dosya adları seçin):

```powershell
node reader/benchmark/download-ollama.mjs qwen3.5:2b
node reader/benchmark/run.mjs --device auto --models qwen3.5:2b --qwen-mode regions --output work/benchmark/qwen35-2b-regions-auto.json
node reader/benchmark/run.mjs --device cpu --models qwen3.5:2b --qwen-mode regions --output work/benchmark/qwen35-2b-regions-cpu.json
node reader/benchmark/run.mjs --device auto --models qwen3.5:2b --output work/benchmark/qwen35-2b-top-auto.json
node reader/benchmark/run.mjs --device cpu --models qwen3.5:2b --output work/benchmark/qwen35-2b-top-cpu.json
```

Bu paket yaklaşık 2,68 GB'dır ve bütün blob'lar resmî manifestteki SHA-256 değerleriyle doğrulandı. GLM/Paddle/Qwen3.5-4B sonuçları 2026-10-02, Qwen3.5-2B sonuçları 2026-10-06 ölçümleridir; aynı makine/motor/veri seti kullanıldı, fakat işletim sistemi ve arka plan yükü günler arasında aynı olmak zorunda değildir. Başka bir Qwen2B quantization paketi veya yeni kâğıtlar için bu sonuçların aynılığı varsayılmamalıdır.

İlk CPU/1600 isteğinin başlangıcında önceki auto testinden kalan benchmark model süreci de bellekteydi; daha sonra temizlendi. Bu satırın ilk okuma süresi temiz başlangıç olarak kullanılmamalıdır. Sıcak süreler ve CPU/1024 deneyinin ayrı kayıtları korunur.

Son seçimde hız, doğruluk ve düşük donanım ihtiyacı birlikte değerlendirilmelidir. Gerçek ofis bilgisayarında ve yeni, daha geniş bir kâğıt setinde doğrulama yapılmadan minimum donanım veya eşdeğer doğruluk iddiasında bulunmayın.
