import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { work } from "./runtime.mjs";

const files = process.argv.slice(2);
if (!files.length) throw new Error("Provide benchmark result JSON files");
const reports = await Promise.all(files.map(async (path) => JSON.parse(await readFile(resolve(path), "utf8"))));
const ratio = (value) => value ? `${value.correct}/${value.total}` : "—";
const seconds = (value) => value == null ? "—" : (value / 1000).toFixed(1);
const gib = (value) => value ? (value / 2 ** 30).toFixed(2) : "—";
const rows = [];
for (const report of reports) {
  for (const model of report.models) {
    const s = model.summary;
    if (!s) continue;
    const first = report.records.find((row) => row.model === model.model && row.cold);
    const input = (model.inputProfile || "top-contract") + (report.dataset.preprocessing?.regionScale > 1 ? ` x${report.dataset.preprocessing.regionScale}` : "");
    rows.push(`| ${model.model} | ${report.device} | ${input} | ${report.dataset.preprocessing?.maxWidth ?? 1600} | ${ratio(s.categories.scores)} | ${ratio(s.categories.total)} | ${ratio(s.categories.identity)} | ${ratio(s.critical)} | ${ratio(s.categories.printed)} | ${seconds(s.medianWarmMs)} | ${seconds(first?.elapsedMs)} | ${seconds(first ? (first.readyElapsedMs ?? first.elapsedMs + model.setupMs) : null)} | ${gib(model.memory.peakResidentBytes)} | ${gib(model.memory.peakPrivateBytes)} | ${gib(model.diskBytes)} | ${s.within120s}/${s.attempts} |`);
  }
}
const lines = ["# Yerel model karşılaştırması", "", "Dört gerçek sınav kâğıdı; sonuçlar bu örneklere aittir. Genel doğruluk yüzdesi veya minimum sistem gereksinimi olarak yorumlanmamalı.", "",
  `Ölçüm günleri (UTC): ${[...new Set(reports.map((report) => report.startedAt.slice(0, 10)))].join(", ")}. Günler arasında işletim sistemi/arka plan yükü aynı olmak zorunda değildir.`, "",
  "| Model | Aygıt profili | Girdi/prompt | Maks. genişlik | Puan | Yazılı toplam | Ad/numara | El yazısı alanları | Basılı alanlar | Sıcak medyan sn | İlk istek sn | Başlangıç + ilk istek sn | Tepe çalışma kümesi GiB | Tepe özel bellek GiB | Model diski GiB | 120 sn içinde |",
  "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|", ...rows, "",
  "`auto`: GPU kullanılabilir; Ollama modellerinin gerçek VRAM kullanım bilgisi JSON kayıtlarındadır. Paddle CUDA backend'i ve GPU süreci ayrıca kontrol edilmiştir; Paddle kayıtları istek başına VRAM sayacı içermez. `cpu`: yalnız CPU, dört iş parçacığı. Daha eski bir işlemciyi veya 8 GB RAM sınırını taklit etmez.", "",
  "Ad ve numara ayrı alanlardır; Türkçe harfler ve numaranın baştaki sıfırları korunmalıdır. İki okumanın anlaşması doğru cevap kanıtı değildir. Puanlar ve yazılı toplam bağımsız değerlendirilir.", "",
  "regions-native / regions-json: elle belirlenmiş aynı öğrenci/ders/puan bölgeleri kullanılır. Üç bölgenin toplam çıkarım süresi raporlanır; otomatik tablo hizalama/bölge bulma süresi dahil değildir. Bu yüzden bölgesel satırlar hazır bir üretim hattının performansı değildir. top-* profilleri uygulamadaki üst tablo görüntüsünü okur.", "",
  "production-adaptive-single: otomatik çizgi/bölge algılama, gerçek CPU/GPU kullanımını doğrulama, gerekiyorsa görüntüsüz model yükleme ve uygulama geri dönüşleri süreye dahildir. CPU tüm tablo bağlamını koruyan boş alt alan kırpmasını; GPU bağlamlı bölgesel okumayı kullanır. Eski üretim referansı production-top-single satırıdır. CLI sharp kodlaması tarayıcı canvas kodlamasıyla bit düzeyinde aynı değildir; telefon aktarımı/UI süresi burada ölçülmez. Ders hücresi sınır ayırıcısı temizliği yeni sürümde vardır; eski kayıtlar değiştirilmedi.", "",
  "glm-ocr-eot:q8_0: resmî Q8 GLM'nin ayrı test kopyası; yalnız eksik EOT bitiş token metadata'sı eklendi. Tüm 527 ağırlık tensörü özgün dosyayla aynı veri SHA-256 değerini taşıyor. Ayrıntılar/provenance yerel JSON kayıtlarındadır. Özgün GLM dosyası ve üretim modeli değiştirilmedi.", "",
  "Bellek değerleri bir saniyelik örneklemeyle süreç ağacından ölçülür. Çalışma kümesi paylaşılan sayfaları iki kez sayabilir; özel bellek ayrılan bellek miktarıdır, minimum RAM ihtiyacı değildir. Sunucu başlangıcı setupMs alanındadır. Ollama ilk isteği model yüklemeyi içerir; Paddle modeli sunucu başlangıcında yükler ve bu yükleme istek süresine dahil değildir.", "",
  ...reports.flatMap((report) => (report.notes || []).flatMap((note) => [note, ""])),
  "## Alan bazında hatalar", ""];
for (const report of reports) {
  for (const row of report.records) {
    const wrong = row.fields.filter((field) => !field.correct).map((field) => field.field);
    const scale = report.dataset.preprocessing?.regionScale > 1 ? ` / bölge x${report.dataset.preprocessing.regionScale}` : "";
    lines.push(`- ${row.model} / ${report.device} / ${row.inputProfile || "top-contract"} / ${report.dataset.preprocessing?.maxWidth ?? 1600}px${scale} / ${row.caseId}: ${row.error ? `istek hatası: ${row.error}` : wrong.length ? `hatalı alanlar: ${wrong.join(", ")}` : "bütün alanlar doğru"}.`);
  }
  for (const failure of report.failures) lines.push(`- ${failure.model} / ${report.device}: çalıştırılamadı (${failure.error}).`);
}
lines.push("", "Ham model cevapları, aygıt durumu ve alanların beklenen/okunan değerleri ilgili JSON sonuç dosyalarında yerel olarak saklanır.", "");
const path = join(work, "comparison.md");
await writeFile(path, lines.join("\n"));
console.log(path);
