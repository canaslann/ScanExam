// Check the connection before browser capabilities: secure-only APIs disappear on HTTP.
export function queueStartupIssue({
  secureContext,
  hasLocks,
}: {
  secureContext: boolean;
  hasLocks: boolean;
}): string | null {
  if (!secureContext)
    return "Bu bağlantı güvenli değil. Telefon taraması için uygulama, telefonun güvendiği bir HTTPS adresinden açılmalı; http://bilgisayar-IP adresi yeterli değildir. Bu, tarayıcınızın desteklenmediği anlamına gelmez. Bilgisayarda http://localhost kullanılabilir.";
  if (!hasLocks)
    return "Bağlantı güvenli, ancak bu tarayıcıda tek-sekme kayıt koruması (Web Locks) kullanılamıyor. Güncel Safari, Chrome veya Edge ile doğrudan açın; uygulama içi tarayıcı kullanıyorsanız bağlantıyı normal tarayıcıya taşıyın. Veri çakışmasını önlemek için tarama başlatılmadı.";
  return null;
}
