import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  ArrowLeft02Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  Delete02Icon,
  DeliverySent02Icon,
  FavouriteIcon,
  GridViewIcon,
  Home01Icon,
  Image03Icon,
  InboxIcon,
  Remove01Icon,
  Search01Icon,
  ShoppingCart01Icon,
  StoreLocation02Icon,
  User02Icon
} from "@hugeicons/core-free-icons";
import "./styles.css";

type Category = { id: string; name: string };
type Product = {
  id: string;
  name: string;
  price: number;
  priceCurrency?: string | null;
  article?: string | null;
  categoryId?: string;
  description?: string | null;
  stock?: number;
  imageCount?: number;
};
type CartItem = Product & { quantity: number };
type Order = { id: string; name: string; moment: string; sum: number; state: string | null };

type Language = "uz" | "uzc" | "ru";
type View = "home" | "catalog" | "catalog-group" | "cart" | "delivery-select" | "saved" | "profile" | "order-detail";

const apiUrl = import.meta.env.VITE_API_URL || "http://localhost:4000";
const MAX_QTY = 9999;

function parseTelegramIdFromWebAppData(rawData: string | null): string | null {
  if (!rawData) return null;
  try {
    const dataParams = new URLSearchParams(decodeURIComponent(rawData));
    const userStr = dataParams.get("user");
    if (!userStr) return null;
    const user = JSON.parse(decodeURIComponent(userStr));
    if (user?.id) return String(user.id);
  } catch {}
  return null;
}

function getTelegramId(): string | null {
  const tgApp = (window as any).Telegram?.WebApp;

  const uid = tgApp?.initDataUnsafe?.user?.id;
  if (uid) return String(uid);

  const urlParam = new URLSearchParams(window.location.search).get("tgId");
  if (urlParam) return urlParam;

  if (tgApp?.initData) {
    try {
      const params = new URLSearchParams(tgApp.initData);
      const userStr = params.get("user");
      if (userStr) {
        const user = JSON.parse(decodeURIComponent(userStr));
        if (user?.id) return String(user.id);
      }
    } catch {}
  }

  if (window.location.hash) {
    try {
      const hashParams = new URLSearchParams(window.location.hash.slice(1));
      const idFromHash = parseTelegramIdFromWebAppData(hashParams.get("tgWebAppData"));
      if (idFromHash) return idFromHash;
    } catch {}
  }

  try {
    const searchParams = new URLSearchParams(window.location.search);
    const idFromSearch = parseTelegramIdFromWebAppData(searchParams.get("tgWebAppData"));
    if (idFromSearch) return idFromSearch;
  } catch {}

  return null;
}

function toLanguage(lang?: string | null): Language {
  if (lang === "uzc") return "uzc";
  if (lang === "ru") return "ru";
  return "uz";
}

function normalizeCurrencyCode(currency?: string | null) {
  if (!currency) return "UZS";
  const trimmed = currency.trim();
  const upper = trimmed.toUpperCase();
  if (upper.includes("UZS") || upper === "UZB" || trimmed === "So'm" || trimmed === "SOM") return "UZS";
  if (upper.includes("RUB") || upper.includes("RUR") || trimmed.includes("₽")) return "RUB";
  if (upper.includes("USD") || trimmed.includes("$")) return "USD";
  if (upper.includes("EUR") || trimmed.includes("€")) return "EUR";
  if (upper.length === 3) return upper;
  return trimmed;
}

function formatCurrencyLabel(currency: string | null | undefined, lang: Language) {
  const code = normalizeCurrencyCode(currency);
  const map: Record<string, Record<Language, string>> = {
    UZS: { uz: "So'm", uzc: "\u0421\u045e\u043c", ru: "\u0441\u0443\u043c" },
    USD: { uz: "USD", uzc: "USD", ru: "\u0434\u043e\u043b\u043b." },
    RUB: { uz: "RUB", uzc: "RUB", ru: "\u0440\u0443\u0431." },
    EUR: { uz: "EUR", uzc: "EUR", ru: "\u0435\u0432\u0440\u043e" }
  };
  return map[code]?.[lang] || code;
}

function formatMoney(value: number, currency: string | null | undefined, lang: Language) {
  const unit = formatCurrencyLabel(currency, lang);
  return `${value.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${unit}`;
}

function formatDate(moment: string) {
  const d = new Date(moment);
  return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function isOutOfStock(product: Product) {
  return (product.stock ?? 0) <= 0;
}

const copy = {
  uz: {
    title: "Mahsulotlar",
    add: "Qo'shish",
    cart: "Savat",
    emptyCart: "Savat bo'sh",
    emptyProducts: "Mahsulot topilmadi",
    total: "Jami",
    pay: "To'lash",
    checkout: "Rasmiylashtirish",
    processing: "Yuklanmoqda...",
    errorCategories: "Bo'limlar yuklanmadi.",
    errorProducts: "Mahsulotlar yuklanmadi.",
    errorTelegram: "Telegram foydalanuvchisi topilmadi.",
    errorOrder: "Savat yuborilmadi. Qayta urinib ko'ring.",
    success: "✅ Buyurtma qabul qilindi!",
    successDelivery: "📍 Botga o'ting va lokatsiyangizni yuboring.",
    retry: "Qayta urinish",
    browse: "Mahsulotlarni ko'rish",
    sku: "Kod",
    search: "Qidirish...",
    deliverySelectTitle: "Buyurtma tafsilotlari",
    orderNoteLabel: "Buyurtma izohi",
    orderNotePlaceholder: "Izoh yozing (ixtiyoriy)",
    pickup: "Olib ketish",
    delivery: "Yetkazib berish",
    backToCart: "Orqaga",
    notRegistered: "Iltimos, avval botda ro'yxatdan o'ting.",
    notDetected: "Telegram orqali oching.",
    balance: "Balans",
    outOfStock: "Qolmagan",
    allProducts: "Barcha mahsulotlar",
    deliveryDetailsTitle: "Yetkazib berish",
    selectOnMap: "Kartada nuqtani belgilang",
    locationPicked: "📍 Joylashuv tanlandi",
    kvartiraLabel: "Kvartira",
    kvartiraPlaceholder: "Kvartira raqami",
    kirishLabel: "Kirish",
    kirishPlaceholder: "Kirish raqami",
    qavatLabel: "Qavat",
    qavatPlaceholder: "Qavat raqami",
    domofonLabel: "Domofon",
    domofonPlaceholder: "Domofon kodi",
    fullAddressLabel: "Manzil",
    fullAddressPlaceholder: "Kartadan nuqta tanlang",
    save: "Saqlash",
    tabHome: "Bosh",
    tabCatalog: "Katalog",
    tabCart: "Savat",
    tabSaved: "Saqlangan",
    tabProfile: "Profil",
    ordersTitle: "Buyurtmalar",
    emptySaved: "Hech narsa saqlanmagan",
    orderStatus: "Holat",
    orderDate: "Sana",
    orderDelivery: "Yetkazish",
    orderAddress: "Manzil",
    orderTotal: "Jami",
    orderCarModel: "Mashina modeli",
    orderCarNumber: "Mashina raqami",
    demands: "Hujjatlar",
    pdfSent: "PDF Telegramga yuborildi",
    orderPaid: "To'langan",
    orderDue: "Qolgan to'lov"
  },
  uzc: {
    title: "Маҳсулотлар",
    add: "Қўшиш",
    cart: "Сават",
    emptyCart: "Сават бўш",
    emptyProducts: "Маҳсулот топилмади",
    total: "Жами",
    pay: "Тўлаш",
    checkout: "\u0420\u0430\u0441\u043c\u0438\u0439\u043b\u0430\u0448\u0442\u0438\u0440\u0438\u0448",
    processing: "Юкланмоқда...",
    errorCategories: "Бўлимлар юкланмади.",
    errorProducts: "Маҳсулотлар юкланмади.",
    errorTelegram: "Telegram фойдаланувчиси топилмади.",
    errorOrder: "Сават юборилмади. Қайта уриниб кўринг.",
    success: "✅ Буюртма қабул қилинди!",
    successDelivery: "📍 Ботга ўтинг ва локациянгизни юборинг.",
    retry: "Қайта уриниш",
    browse: "Маҳсулотларни кўриш",
    sku: "Код",
    search: "Қидириш...",
    deliverySelectTitle: "\u0411\u0443\u044e\u0440\u0442\u043c\u0430 \u0442\u0430\u0444\u0441\u0438\u043b\u043e\u0442\u043b\u0430\u0440\u0438",
    orderNoteLabel: "\u0411\u0443\u044e\u0440\u0442\u043c\u0430 \u0438\u0437\u043e\u04b3\u0438",
    orderNotePlaceholder: "\u0418\u0437\u043e\u04b3 \u0451\u0437\u0438\u043d\u0433 (\u0438\u0445\u0442\u0438\u0451\u0440\u0438\u0439)",
    pickup: "Олиб кетиш",
    delivery: "Йетказиб бериш",
    backToCart: "Орқага",
    notRegistered: "Илтимос, аввал ботда рўйхатдан ўтинг.",
    notDetected: "Telegram орқали очинг.",
    balance: "Баланс",
    outOfStock: "Қолмаган",
    allProducts: "Барча маҳсулотлар",
    deliveryDetailsTitle: "Йетказиб бериш",
    selectOnMap: "Картада нуқтани белгиланг",
    locationPicked: "📍 Жойлашув танланди",
    kvartiraLabel: "Квартира",
    kvartiraPlaceholder: "Квартира рақами",
    kirishLabel: "Кириш",
    kirishPlaceholder: "Кириш рақами",
    qavatLabel: "Қават",
    qavatPlaceholder: "Қават рақами",
    domofonLabel: "Домофон",
    domofonPlaceholder: "Домофон коди",
    fullAddressLabel: "Манзил",
    fullAddressPlaceholder: "Картадан нуқта танланг",
    save: "Сақлаш",
    tabHome: "Бош",
    tabCatalog: "Каталог",
    tabCart: "Сават",
    tabSaved: "Сақланган",
    tabProfile: "Профил",
    ordersTitle: "Буюртмалар",
    emptySaved: "Ҳеч нима сақланмаган",
    orderStatus: "Ҳолат",
    orderDate: "Санa",
    orderDelivery: "Йетказиш",
    orderAddress: "Манзил",
    orderTotal: "Жами",
    orderCarModel: "Машина модели",
    orderCarNumber: "Машина рақами",
    demands: "Ҳужжатлар",
    pdfSent: "PDF Telegramга юборилди",
    orderPaid: "Тўланган",
    orderDue: "Қолган тўлов"
  },
  ru: {
    title: "Товары",
    add: "Добавить",
    cart: "Корзина",
    emptyCart: "Корзина пуста",
    emptyProducts: "Товар не найден",
    total: "Итого",
    pay: "Оплатить",
    checkout: "Оформить заказ",
    processing: "Загрузка...",
    errorCategories: "Категории не загрузились.",
    errorProducts: "Товары не загрузились.",
    errorTelegram: "Пользователь Telegram не найден.",
    errorOrder: "Корзина не отправлена. Попробуйте снова.",
    success: "✅ Заказ принят!",
    successDelivery: "📍 Перейдите в бот и отправьте локацию.",
    retry: "Повторить",
    browse: "Смотреть товары",
    sku: "Код",
    search: "Поиск...",
    deliverySelectTitle: "Детали заказа",
    orderNoteLabel: "Комментарий к заказу",
    orderNotePlaceholder: "Напишите комментарий (необязательно)",
    pickup: "Самовывоз",
    delivery: "Доставка",
    backToCart: "Назад",
    notRegistered: "Пожалуйста, сначала зарегистрируйтесь в боте.",
    notDetected: "Откройте через Telegram.",
    balance: "Баланс",
    outOfStock: "Нет в наличии",
    allProducts: "Все товары",
    deliveryDetailsTitle: "Доставка",
    selectOnMap: "Отметьте точку на карте",
    locationPicked: "📍 Местоположение выбрано",
    kvartiraLabel: "Квартира",
    kvartiraPlaceholder: "Номер квартиры",
    kirishLabel: "Подъезд",
    kirishPlaceholder: "Номер подъезда",
    qavatLabel: "Этаж",
    qavatPlaceholder: "Номер этажа",
    domofonLabel: "Домофон",
    domofonPlaceholder: "Код домофона",
    fullAddressLabel: "Адрес",
    fullAddressPlaceholder: "Выберите точку на карте",
    save: "Сохранить",
    tabHome: "Главная",
    tabCatalog: "Каталог",
    tabCart: "Корзина",
    tabSaved: "Сохранённые",
    tabProfile: "Профиль",
    ordersTitle: "Заказы",
    emptySaved: "Ничего не сохранено",
    orderStatus: "Статус",
    orderDate: "Дата",
    orderDelivery: "Доставка",
    orderAddress: "Адрес",
    orderTotal: "Итого",
    orderCarModel: "Модель машины",
    orderCarNumber: "Номер машины",
    demands: "Документы",
    pdfSent: "PDF отправлен в Telegram",
    orderPaid: "Оплачено",
    orderDue: "Осталось оплатить"
  }
};

function HeartFilledIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M11.645 20.91l-.007-.003-.022-.012a15.247 15.247 0 01-.383-.218 25.18 25.18 0 01-4.244-3.17C4.688 15.36 2.25 12.174 2.25 8.25 2.25 5.322 4.714 3 7.688 3A5.5 5.5 0 0112 5.052 5.5 5.5 0 0116.313 3c2.973 0 5.437 2.322 5.437 5.25 0 3.925-2.438 7.111-4.739 9.256a25.175 25.175 0 01-4.244 3.17 15.247 15.247 0 01-.383.219l-.022.012-.007.004-.003.001a.752.752 0 01-.704 0l-.003-.001z" />
    </svg>
  );
}

function CartItemWrapper({ children, leaving }: { children: React.ReactNode; leaving: boolean }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!leaving || !ref.current) return;
    const el = ref.current;
    el.style.height = el.scrollHeight + "px";
    el.style.overflow = "hidden";
    el.offsetHeight;
    el.style.transition = "height 0.3s ease, opacity 0.22s ease";
    el.style.height = "0";
    el.style.opacity = "0";
  }, [leaving]);

  return (
    <div ref={ref} className="cart-item-wrapper">
      {children}
    </div>
  );
}

interface SheetProps {
  product: Product;
  categoryName: string;
  cartItem: CartItem | undefined;
  bouncingItem: string | null;
  editingQuantity: string | null;
  setEditingQuantity: (id: string | null) => void;
  onClose: () => void;
  onAdd: (product: Product) => void;
  onIncrement: (id: string) => void;
  onDecrement: (id: string) => void;
  onUpdateQuantity: (id: string, qty: number) => void;
  lang: Language;
  t: { add: string; outOfStock: string };
  isLiked: boolean;
  onToggleLike: (e: React.MouseEvent) => void;
}

function ProductSheet({
  product,
  categoryName,
  cartItem,
  bouncingItem,
  editingQuantity,
  setEditingQuantity,
  onClose,
  onAdd,
  onIncrement,
  onDecrement,
  onUpdateQuantity,
  lang,
  t,
  isLiked,
  onToggleLike
}: SheetProps) {
  const [mounted, setMounted] = useState(false);
  const [closing, setClosing] = useState(false);
  const [images, setImages] = useState<Array<{ id: string; url: string }>>([]);
  const [imageIdx, setImageIdx] = useState(0);
  const touchStartX = useRef(0);

  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    if (!product.imageCount) return;
    fetch(`${apiUrl}/api/products/${product.id}/images`)
      .then((r) => r.ok ? r.json() : [])
      .then((data: Array<{ id: string; url: string }>) => setImages(data))
      .catch(() => {});
  }, [product.id, product.imageCount]);

  function dismiss() {
    setClosing(true);
  }

  function onGalleryTouchStart(e: React.TouchEvent) {
    touchStartX.current = e.touches[0].clientX;
  }

  function onGalleryTouchEnd(e: React.TouchEvent) {
    const delta = e.changedTouches[0].clientX - touchStartX.current;
    if (delta < -40 && imageIdx < images.length - 1) setImageIdx((i) => i + 1);
    if (delta > 40 && imageIdx > 0) setImageIdx((i) => i - 1);
  }

  const stockLimit = product.stock ?? MAX_QTY;
  const outOfStock = stockLimit <= 0;
  const sheetTransform = !mounted || closing ? "translateY(110%)" : "translateY(0)";
  const sheetTransition = "transform 0.38s cubic-bezier(0.25, 0.46, 0.45, 0.94)";
  const backdropOpacity = mounted && !closing ? 1 : 0;

  return (
    <>
      <div
        className="sheet-backdrop"
        onClick={dismiss}
        style={{ opacity: backdropOpacity, transition: "opacity 0.3s ease" }}
      />
      <div
        className="product-sheet"
        style={{ transform: sheetTransform, transition: sheetTransition }}
        onTransitionEnd={(e) => { if (closing && e.propertyName === "transform") onClose(); }}
      >
        <div className="sheet-top-bar">
          <button className="sheet-close-btn" onClick={dismiss}>
            <HugeiconsIcon icon={Cancel01Icon} size={18} color="currentColor" strokeWidth={2.5} />
          </button>
        </div>
        <div
          className="sheet-image-area"
          onTouchStart={onGalleryTouchStart}
          onTouchEnd={onGalleryTouchEnd}
        >
          <button
            className={`sheet-heart-btn${isLiked ? " liked" : ""}`}
            onClick={onToggleLike}
            aria-label="Like"
          >
            {isLiked
              ? <HeartFilledIcon size={18} />
              : <HugeiconsIcon icon={FavouriteIcon} size={18} color="currentColor" strokeWidth={2} />
            }
          </button>
          {images.length > 0 ? (
            <>
              <div
                className="sheet-images-track"
                style={{ transform: `translateX(-${imageIdx * 100}%)` }}
              >
                {images.map((img) => (
                  <img
                    key={img.id}
                    className="sheet-img"
                    src={`${apiUrl}${img.url}`}
                    alt={product.name}
                    draggable={false}
                  />
                ))}
              </div>
              {images.length > 1 && (
                <div className="sheet-image-dots">
                  {images.map((_, i) => (
                    <div
                      key={i}
                      className={`sheet-dot${i === imageIdx ? " active" : ""}`}
                      onClick={() => setImageIdx(i)}
                    />
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="image-placeholder">
              <HugeiconsIcon icon={Image03Icon} size={32} color="currentColor" strokeWidth={1.5} />
            </div>
          )}
        </div>
        <div className="sheet-body">
          <div className="sheet-name">{product.name}</div>
          {categoryName && <div className="sheet-category">{categoryName}</div>}
          {product.description && <div className="sheet-description">{product.description}</div>}
        </div>
        <div className="sheet-footer">
          <div className="sheet-price">{formatMoney(product.price, product.priceCurrency, lang)}</div>
          {outOfStock && <div className="out-of-stock-text">{t.outOfStock}</div>}
          {cartItem ? (
            <div className={`quantity-control sheet-qty${bouncingItem === product.id ? " bounce" : ""}`}>
              <button className="qty-btn" onClick={() => onDecrement(product.id)}>
                <HugeiconsIcon icon={Remove01Icon} size={18} color="currentColor" strokeWidth={2} />
              </button>
              {editingQuantity === product.id ? (
                <input
                  type="number"
                  className="qty-input"
                  value={cartItem.quantity}
                  autoFocus
                  onFocus={(e) => e.target.select()}
                  onChange={(e) => onUpdateQuantity(product.id, Math.max(1, parseInt(e.target.value) || 1))}
                  onBlur={() => setEditingQuantity(null)}
                  onKeyDown={(e) => { if (e.key === "Enter") setEditingQuantity(null); }}
                />
              ) : (
                <span className="qty-value" onClick={() => setEditingQuantity(product.id)}>
                  {cartItem.quantity}
                </span>
              )}
              <button
                className="qty-btn"
                onClick={() => onIncrement(product.id)}
                disabled={cartItem.quantity >= stockLimit}
              >
                <HugeiconsIcon icon={Add01Icon} size={18} color="currentColor" strokeWidth={2} />
              </button>
            </div>
          ) : (
            <button
              className="sheet-add-btn"
              onClick={() => onAdd(product)}
              disabled={stockLimit <= 0}
            >
              {outOfStock ? (
                t.outOfStock
              ) : (
                <>
                  <HugeiconsIcon icon={Add01Icon} size={18} color="currentColor" strokeWidth={2} />
                  {t.add}
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </>
  );
}

async function geocodeCoords(lng: number, lat: number): Promise<string> {
  const apiKey = import.meta.env.VITE_YANDEX_MAPS_API_KEY;
  const resp = await fetch(
    `https://geocode-maps.yandex.ru/1.x/?apikey=${apiKey}&geocode=${lng},${lat}&format=json&lang=ru_RU`
  );
  const data = await resp.json();
  return (
    data?.response?.GeoObjectCollection?.featureMember?.[0]
      ?.GeoObject?.metaDataProperty?.GeocoderMetaData?.text || ""
  );
}

function parseAddressExtra(extra: string | null | undefined) {
  const result = { kvartira: "", kirish: "", qavat: "", domofon: "" };
  if (!extra) return result;
  const parts = extra.split(";").map((s) => s.trim());
  for (const part of parts) {
    const kv = part.match(/^kv\.\s*(.+)$/i);
    if (kv) { result.kvartira = kv[1].trim(); continue; }
    const ki = part.match(/^kirish\s+(.+)$/i);
    if (ki) { result.kirish = ki[1].trim(); continue; }
    const qa = part.match(/^qavat\s+(.+)$/i);
    if (qa) { result.qavat = qa[1].trim(); continue; }
    const dm = part.match(/^domofon\s+(.+)$/i);
    if (dm) { result.domofon = dm[1].trim(); continue; }
  }
  return result;
}

function YandexMapPicker({
  onSelect,
  lat,
  lng,
  className
}: {
  onSelect: (lat: number, lng: number) => void;
  lat: number | null;
  lng: number | null;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const markerRef = useRef<any>(null);
  const onSelectRef = useRef(onSelect);
  useEffect(() => { onSelectRef.current = onSelect; }, [onSelect]);

  useEffect(() => {
    const apiKey = import.meta.env.VITE_YANDEX_MAPS_API_KEY;
    if (!document.getElementById("ymaps3-script")) {
      const script = document.createElement("script");
      script.id = "ymaps3-script";
      script.src = `https://api-maps.yandex.ru/v3/?apikey=${apiKey}&lang=ru_RU`;
      document.head.appendChild(script);
    }

    let destroyed = false;
    const initMap = async () => {
      if (destroyed || !containerRef.current || mapRef.current) return;
      const ymaps3 = (window as any).ymaps3;
      if (!ymaps3) return;
      await ymaps3.ready;
      if (destroyed || !containerRef.current || mapRef.current) return;
      const { YMap, YMapDefaultSchemeLayer, YMapDefaultFeaturesLayer, YMapListener } = ymaps3;
      const map = new YMap(containerRef.current, {
        location: { center: [69.24, 41.30], zoom: 12 }
      });
      map.addChild(new YMapDefaultSchemeLayer());
      map.addChild(new YMapDefaultFeaturesLayer());
      const listener = new YMapListener({
        layer: "any",
        onClick: (_obj: any, event: any) => {
          const [clickLng, clickLat] = event.coordinates;
          onSelectRef.current(clickLat, clickLng);
        }
      });
      map.addChild(listener);
      mapRef.current = map;
    };

    const script = document.getElementById("ymaps3-script") as HTMLScriptElement | null;
    if ((window as any).ymaps3) {
      initMap();
      return () => {
        destroyed = true;
        if (mapRef.current) { mapRef.current.destroy?.(); mapRef.current = null; }
      };
    } else if (script) {
      script.addEventListener("load", initMap);
      return () => {
        destroyed = true;
        script.removeEventListener("load", initMap);
        if (mapRef.current) { mapRef.current.destroy?.(); mapRef.current = null; }
      };
    }
    return () => {
      destroyed = true;
      if (mapRef.current) { mapRef.current.destroy?.(); mapRef.current = null; }
    };
  }, []);

  useEffect(() => {
    if (!mapRef.current || lat === null || lng === null) return;
    const ymaps3 = (window as any).ymaps3;
    if (!ymaps3) return;
    const { YMapMarker } = ymaps3;
    if (markerRef.current) {
      mapRef.current.removeChild(markerRef.current);
      markerRef.current = null;
    }
    const el = document.createElement("div");
    el.className = "ymap-marker";
    const marker = new YMapMarker({ coordinates: [lng, lat] }, el);
    mapRef.current.addChild(marker);
    markerRef.current = marker;
    mapRef.current.setLocation({ center: [lng, lat], zoom: 15, duration: 300 });
  }, [lat, lng]);

  return <div ref={containerRef} className={className || "ymap-container"} />;
}

function MapDrawer({
  lat,
  lng,
  address,
  onSelect,
  onClose,
  t
}: {
  lat: number | null;
  lng: number | null;
  address: string;
  onSelect: (lat: number, lng: number, address: string) => void;
  onClose: () => void;
  t: { save: string; selectOnMap: string };
}) {
  const [mounted, setMounted] = useState(false);
  const [closing, setClosing] = useState(false);
  const [localLat, setLocalLat] = useState<number | null>(lat);
  const [localLng, setLocalLng] = useState<number | null>(lng);
  const [localAddress, setLocalAddress] = useState(address);

  useEffect(() => { setMounted(true); }, []);

  function dismiss() { setClosing(true); }

  async function handleMapSelect(selLat: number, selLng: number) {
    setLocalLat(selLat);
    setLocalLng(selLng);
    try {
      const addr = await geocodeCoords(selLng, selLat);
      if (addr) setLocalAddress(addr);
    } catch {}
  }

  function handleSave() {
    if (localLat !== null && localLng !== null) {
      onSelect(localLat, localLng, localAddress);
    }
    dismiss();
  }

  const drawerTransform = !mounted || closing ? "translateY(110%)" : "translateY(0)";
  const drawerTransition = "transform 0.38s cubic-bezier(0.25, 0.46, 0.45, 0.94)";
  const backdropOpacity = mounted && !closing ? 1 : 0;

  return (
    <>
      <div
        className="sheet-backdrop"
        onClick={dismiss}
        style={{ opacity: backdropOpacity, transition: "opacity 0.3s ease" }}
      />
      <div
        className="map-drawer"
        style={{ transform: drawerTransform, transition: drawerTransition }}
        onTransitionEnd={(e) => {
          if (closing && e.propertyName === "transform") onClose();
        }}
      >
        <YandexMapPicker
          onSelect={handleMapSelect}
          lat={localLat}
          lng={localLng}
          className="ymap-fullscreen"
        />
        <button className="map-drawer-close" onClick={dismiss}>
          <HugeiconsIcon icon={Cancel01Icon} size={18} color="currentColor" strokeWidth={2.5} />
        </button>
        <div className="map-drawer-footer">
          <div className="map-drawer-address-text">
            {localAddress || t.selectOnMap}
          </div>
          <button
            className="pay-button"
            onClick={handleSave}
            disabled={localLat === null}
          >
            <span className="pay-button-content">{t.save}</span>
          </button>
        </div>
      </div>
    </>
  );
}

export default function App() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [loadingCategories, setLoadingCategories] = useState(false);
  const [loadingGrouped, setLoadingGrouped] = useState(false);
  const [groupedProducts, setGroupedProducts] = useState<Record<string, Product[]>>({});
  const [cart, setCart] = useState<CartItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<View>("home");
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const headerSearchRef = useRef<HTMLDivElement>(null);
  const [editingQuantity, setEditingQuantity] = useState<string | null>(null);
  const [bouncingItem, setBouncingItem] = useState<string | null>(null);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [selectedDeliveryMethod, setSelectedDeliveryMethod] = useState<"pickup" | "delivery" | null>(null);
  const [orderNote, setOrderNote] = useState("");
  const [leavingItems, setLeavingItems] = useState<Set<string>>(new Set());
  const [bottomVisible, setBottomVisible] = useState(false);
  const [bottomLeaving, setBottomLeaving] = useState(false);
  const [userInfo, setUserInfo] = useState<{
    isRegistered: boolean;
    balance?: number;
    balanceCurrency?: string | null;
    language?: string;
    firstName?: string | null;
    phoneNumber?: string | null;
    counterpartyName?: string | null;
    defaultLat?: number | null;
    defaultLng?: number | null;
    defaultAddressText?: string | null;
    defaultAddressExtra?: string | null;
  } | null>(null);
  const [userInfoLoading, setUserInfoLoading] = useState(true);
  const [telegramId, setTelegramId] = useState<string | null>(null);
  const [deliveryLat, setDeliveryLat] = useState<number | null>(null);
  const [deliveryLng, setDeliveryLng] = useState<number | null>(null);
  const [addrKvartira, setAddrKvartira] = useState("");
  const [addrKirish, setAddrKirish] = useState("");
  const [addrQavat, setAddrQavat] = useState("");
  const [addrDomofon, setAddrDomofon] = useState("");
  const [deliveryAddress, setDeliveryAddress] = useState("");
  const [mapDrawerOpen, setMapDrawerOpen] = useState(false);

  // New state for tab bar and new views
  const [selectedCatalogCategory, setSelectedCatalogCategory] = useState<Category | null>(null);
  const [likedIds, setLikedIds] = useState<Set<string>>(new Set());
  const [orders, setOrders] = useState<Order[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState<string | null>(null);
  const [selectedOrderName, setSelectedOrderName] = useState<string | null>(null);
  const [orderDetail, setOrderDetail] = useState<{
    order: any;
    positions: any[];
    deliveryMethod: string | null;
    driverInfo: { model: string | null; number: string | null } | null;
    addressText: string | null;
    addressExtra: string | null;
    paidAmount?: number;
    dueAmount?: number;
  } | null>(null);
  const [orderDetailLoading, setOrderDetailLoading] = useState(false);
  const [loadingDemandId, setLoadingDemandId] = useState<string | null>(null);

  const lang = useMemo(() => toLanguage(userInfo?.language), [userInfo?.language]);
  const t = copy[lang];

  const [titleDisplay, setTitleDisplay] = useState(t.title);
  const [titlePhase, setTitlePhase] = useState<"enter" | "exit">("enter");
  const [titleKey, setTitleKey] = useState(0);
  const isFirstMount = useRef(true);

  // Tab bar visibility
  const showTabBar = !["cart", "delivery-select", "order-detail"].includes(view);

  // Total items for cart badge
  const totalItems = cart.reduce((sum, item) => sum + item.quantity, 0);

  useEffect(() => {
    const tg = (window as any).Telegram?.WebApp;
    if (tg) {
      tg.ready();
      tg.expand();
    }
  }, []);

  useEffect(() => {
    let attempts = 0;
    const tryResolve = () => {
      const id = getTelegramId();
      if (id) {
        setTelegramId(id);
        return true;
      }
      return false;
    };

    if (tryResolve()) return;

    const timer = window.setInterval(() => {
      attempts += 1;
      if (tryResolve() || attempts >= 12) {
        window.clearInterval(timer);
      }
    }, 250);

    const onHashChange = () => {
      if (tryResolve()) window.clearInterval(timer);
    };
    window.addEventListener("hashchange", onHashChange);

    return () => {
      window.clearInterval(timer);
      window.removeEventListener("hashchange", onHashChange);
    };
  }, []);

  useEffect(() => {
    if (!telegramId) {
      setUserInfoLoading(false);
      return;
    }
    setUserInfoLoading(true);
    fetch(`${apiUrl}/api/user-info?telegramId=${telegramId}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (data) setUserInfo(data); })
      .catch(() => {})
      .finally(() => setUserInfoLoading(false));
  }, [telegramId]);

  // Fetch liked products after user info loaded
  useEffect(() => {
    if (!telegramId || !userInfo?.isRegistered) return;
    fetch(`${apiUrl}/api/liked?telegramId=${telegramId}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (data?.productIds) setLikedIds(new Set(data.productIds)); })
      .catch(() => {});
  }, [telegramId, userInfo?.isRegistered]);

  // Fetch orders when profile view is opened
  useEffect(() => {
    if (view !== "profile" || !telegramId) return;
    setOrdersLoading(true);
    fetch(`${apiUrl}/api/orders?telegramId=${telegramId}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (data?.rows) setOrders(data.rows); })
      .catch(() => {})
      .finally(() => setOrdersLoading(false));
  }, [view, telegramId]);

  useEffect(() => {
    if (isFirstMount.current) {
      isFirstMount.current = false;
      return;
    }
    setTitlePhase("exit");
    const timer = setTimeout(() => {
      let newTitle: string;
      if (view === "cart") newTitle = t.cart;
      else if (view === "delivery-select") newTitle = t.deliverySelectTitle;
      else if (view === "catalog") newTitle = t.tabCatalog;
      else if (view === "catalog-group") newTitle = selectedCatalogCategory?.name || t.tabCatalog;
      else if (view === "saved") newTitle = t.tabSaved;
      else if (view === "profile") newTitle = t.tabProfile;
      else if (view === "order-detail") newTitle = selectedOrderName || "...";
      else newTitle = t.title;
      setTitleDisplay(newTitle);
      setTitleKey((k) => k + 1);
      setTitlePhase("enter");
    }, 160);
    return () => clearTimeout(timer);
  }, [view, t.cart, t.title, t.deliverySelectTitle, t.tabCatalog, t.tabSaved, t.tabProfile,
      selectedCatalogCategory?.name, selectedOrderName]);

  useEffect(() => {
    if (view === "delivery-select") {
      setSelectedDeliveryMethod(null);
    }
  }, [view]);

  useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus();
    } else {
      setSearchQuery("");
    }
  }, [searchOpen]);

  const closeSearch = useCallback(() => setSearchOpen(false), []);

  useEffect(() => {
    if (cart.length > 0) {
      setBottomLeaving(false);
      setBottomVisible(true);
    } else if (bottomVisible) {
      setBottomLeaving(true);
      const timer = setTimeout(() => {
        setBottomVisible(false);
        setBottomLeaving(false);
      }, 320);
      return () => clearTimeout(timer);
    }
  }, [cart.length]);

  const selectedProductCategory = useMemo(
    () => categories.find((c) => c.id === selectedProduct?.categoryId),
    [categories, selectedProduct]
  );

  useEffect(() => {
    if (!selectedProduct) return;
    function handleEsc(e: KeyboardEvent) {
      if (e.key === "Escape") setSelectedProduct(null);
    }
    document.addEventListener("keydown", handleEsc);
    return () => document.removeEventListener("keydown", handleEsc);
  }, [selectedProduct]);

  useEffect(() => {
    if (!searchOpen) return;
    function handleOutside(e: MouseEvent | TouchEvent) {
      if (
        searchQuery.trim() === "" &&
        headerSearchRef.current &&
        !headerSearchRef.current.contains(e.target as Node)
      ) {
        closeSearch();
      }
    }
    document.addEventListener("mousedown", handleOutside);
    document.addEventListener("touchstart", handleOutside);
    return () => {
      document.removeEventListener("mousedown", handleOutside);
      document.removeEventListener("touchstart", handleOutside);
    };
  }, [searchOpen, searchQuery, closeSearch]);

  useEffect(() => {
    const load = async () => {
      setLoadingCategories(true);
      try {
        const catRes = await fetch(`${apiUrl}/api/categories`);
        if (!catRes.ok) throw new Error("Failed to fetch");
        const data = (await catRes.json()) as Category[];
        setCategories(
          data.map((category) =>
            category.id === "all" ? { ...category, name: t.allProducts } : category
          )
        );
      } catch {
        setError(t.errorCategories);
      } finally {
        setLoadingCategories(false);
      }
    };
    load();
  }, [reloadKey, t.errorCategories, t.allProducts]);

  useEffect(() => {
    if (categories.length === 0) return;
    let cancelled = false;
    setLoadingGrouped(true);
    setGroupedProducts({});

    Promise.allSettled(
      categories.map(async (category) => {
        try {
          const prodRes = await fetch(`${apiUrl}/api/products?categoryId=${category.id}`);
          if (cancelled || !prodRes.ok) return;
          const items = (await prodRes.json()) as Product[];
          if (!cancelled && items.length) {
            setGroupedProducts((prev) => ({ ...prev, [category.id]: items }));
          }
        } catch {}
      })
    ).then(() => {
      if (!cancelled) setLoadingGrouped(false);
    });

    return () => { cancelled = true; };
  }, [categories, reloadKey]);

  const categoriesWithItems = useMemo(
    () => categories.filter((category) => (groupedProducts[category.id] || []).length > 0),
    [categories, groupedProducts]
  );

  const filteredGroupedProducts = useMemo(() => {
    if (!searchQuery.trim()) return groupedProducts;

    const query = searchQuery.toLowerCase().trim();
    const filtered: Record<string, Product[]> = {};

    Object.entries(groupedProducts).forEach(([categoryId, products]) => {
      const matchedProducts = products.filter((product) =>
        product.name.toLowerCase().includes(query) ||
        product.article?.toLowerCase().includes(query)
      );
      if (matchedProducts.length > 0) filtered[categoryId] = matchedProducts;
    });

    return filtered;
  }, [groupedProducts, searchQuery]);

  const filteredCategoriesWithItems = useMemo(
    () => categoriesWithItems.filter((cat) => (filteredGroupedProducts[cat.id] || []).length > 0),
    [categoriesWithItems, filteredGroupedProducts]
  );

  const flatFilteredProducts = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const items = filteredCategoriesWithItems.flatMap((cat) => filteredGroupedProducts[cat.id] || []);
    return items.sort((a, b) => {
      const stockDelta = Number(isOutOfStock(a)) - Number(isOutOfStock(b));
      if (stockDelta !== 0) return stockDelta;
      return a.name.localeCompare(b.name);
    });
  }, [searchQuery, filteredCategoriesWithItems, filteredGroupedProducts]);

  const total = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const totalCurrency = cart[0]?.priceCurrency;

  // Liked toggle
  const toggleLike = useCallback((productId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setLikedIds((prev) => {
      const next = new Set(prev);
      if (next.has(productId)) next.delete(productId);
      else next.add(productId);
      return next;
    });
    if (telegramId) {
      fetch(`${apiUrl}/api/liked`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ telegramId, productId })
      }).catch(() => {
        // revert on error
        setLikedIds((prev) => {
          const next = new Set(prev);
          if (next.has(productId)) next.delete(productId);
          else next.add(productId);
          return next;
        });
      });
    }
    (window as any).Telegram?.WebApp?.HapticFeedback?.impactOccurred?.("light");
  }, [telegramId]);

  // Open order detail
  function openOrderDetail(orderId: string, orderName: string) {
    setSelectedOrder(orderId);
    setSelectedOrderName(orderName);
    setView("order-detail");
    setOrderDetailLoading(true);
    setOrderDetail(null);
    fetch(`${apiUrl}/api/orders/${orderId}/positions`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (data) setOrderDetail(data); })
      .catch(() => {})
      .finally(() => setOrderDetailLoading(false));
  }

  // Request demand PDF via Telegram
  function requestDemandPdf(demandId: string) {
    if (!telegramId || loadingDemandId) return;
    (window as any).Telegram?.WebApp?.HapticFeedback?.impactOccurred?.("light");
    setLoadingDemandId(demandId);
    fetch(`${apiUrl}/api/demands/${demandId}/pdf?telegramId=${telegramId}`, { method: "POST" })
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        setLoadingDemandId(null);
        if (data?.ok) {
          (window as any).Telegram?.WebApp?.showAlert?.(t.pdfSent);
        }
      })
      .catch(() => { setLoadingDemandId(null); });
  }

  const addToCart = useCallback((product: Product) => {
    const stockLimit = product.stock ?? MAX_QTY;
    if (stockLimit <= 0) return;
    setCart((prev) => {
      const existing = prev.find((item) => item.id === product.id);
      if (existing) {
        const newQty = Math.min(existing.quantity + 1, stockLimit);
        if (newQty === existing.quantity) return prev;
        return prev.map((item) =>
          item.id === product.id ? { ...item, quantity: newQty } : item
        );
      }
      return [...prev, { ...product, quantity: 1 }];
    });
    (window as any).Telegram?.WebApp?.HapticFeedback?.impactOccurred?.("light");
    setBouncingItem(product.id);
    setTimeout(() => setBouncingItem(null), 300);
  }, []);

  const incrementQuantity = useCallback((id: string) => {
    setCart((prev) => prev.map((item) =>
      item.id === id ? { ...item, quantity: Math.min(item.quantity + 1, item.stock ?? MAX_QTY) } : item
    ));
    (window as any).Telegram?.WebApp?.HapticFeedback?.impactOccurred?.("light");
    setBouncingItem(id);
    setTimeout(() => setBouncingItem(null), 300);
  }, []);

  const decrementQuantity = useCallback((id: string) => {
    const currentItem = cart.find((i) => i.id === id);
    if (!currentItem) return;

    if (currentItem.quantity === 1) {
      setLeavingItems((prev) => new Set([...prev, id]));
      setTimeout(() => {
        setCart((c) => c.filter((i) => i.id !== id));
        setLeavingItems((prev) => { const n = new Set(prev); n.delete(id); return n; });
      }, 300);
    } else {
      setCart((prev) => prev.map((i) => i.id === id ? { ...i, quantity: i.quantity - 1 } : i));
      setBouncingItem(id);
      setTimeout(() => setBouncingItem(null), 300);
    }
    (window as any).Telegram?.WebApp?.HapticFeedback?.impactOccurred?.("light");
  }, [cart]);

  function updateQuantity(id: string, quantity: number) {
    if (quantity <= 0) {
      setCart((prev) => prev.filter((item) => item.id !== id));
      return;
    }
    setCart((prev) => prev.map((item) =>
      item.id === id ? { ...item, quantity: Math.min(quantity, item.stock ?? MAX_QTY) } : item
    ));
  }

  function clearCart() {
    setCart([]);
    setOrderNote("");
    (window as any).Telegram?.WebApp?.HapticFeedback?.impactOccurred?.("medium");
  }

  function retryLoad() {
    setError("");
    setReloadKey((prev) => prev + 1);
  }

  async function handleCheckoutWithMethod(method: "pickup" | "delivery") {
    if (!cart.length) return;
    setLoading(true);
    setError("");
    try {
      if (!telegramId) {
        setError(t.errorTelegram);
        return;
      }
      const response = await fetch(`${apiUrl}/api/draft-order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          telegramId: String(telegramId),
          language: lang,
          deliveryMethod: method,
          orderNote: orderNote.trim() || null,
          items: cart.map((item) => ({ id: item.id, quantity: item.quantity }))
        })
      });
      if (!response.ok) throw new Error("Order failed");
      setOrderNote("");
      const telegram = (window as any).Telegram?.WebApp;
      const message = method === "delivery" ? t.successDelivery : t.success;
      if (telegram?.showAlert) {
        telegram.showAlert(message, () => telegram.close());
        return;
      }
      setCart([]);
    } catch {
      setError(t.errorOrder);
    } finally {
      setLoading(false);
    }
  }

  const deliveryPreFilled = useRef(false);
  useEffect(() => {
    if (selectedDeliveryMethod !== "delivery") {
      deliveryPreFilled.current = false;
      return;
    }
    if (deliveryPreFilled.current || deliveryLat !== null) return;
    const dLat = userInfo?.defaultLat;
    const dLng = userInfo?.defaultLng;
    const dText = userInfo?.defaultAddressText;
    const dExtra = userInfo?.defaultAddressExtra;
    if (!dLat || !dLng) return;
    deliveryPreFilled.current = true;
    setDeliveryLat(dLat);
    setDeliveryLng(dLng);
    if (dText) setDeliveryAddress(dText);
    if (dExtra) {
      const parsed = parseAddressExtra(dExtra);
      setAddrKvartira(parsed.kvartira);
      setAddrKirish(parsed.kirish);
      setAddrQavat(parsed.qavat);
      setAddrDomofon(parsed.domofon);
    }
  }, [selectedDeliveryMethod, userInfo?.defaultLat, userInfo?.defaultLng, userInfo?.defaultAddressText, userInfo?.defaultAddressExtra, deliveryLat]);

  async function handleDeliverySubmit() {
    if (!deliveryLat || !deliveryLng) return;
    setLoading(true);
    setError("");
    try {
      if (!telegramId) {
        setError(t.errorTelegram);
        return;
      }
      const addressDetails = deliveryAddress.trim() || null;
      const extraParts = [
        addrKvartira.trim() ? `kv. ${addrKvartira.trim()}` : null,
        addrKirish.trim() ? `kirish ${addrKirish.trim()}` : null,
        addrQavat.trim() ? `qavat ${addrQavat.trim()}` : null,
        addrDomofon.trim() ? `domofon ${addrDomofon.trim()}` : null
      ].filter(Boolean);
      const addressExtra = extraParts.length > 0 ? extraParts.join("; ") : null;
      const response = await fetch(`${apiUrl}/api/draft-order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          telegramId: String(telegramId),
          language: lang,
          deliveryMethod: "delivery",
          orderNote: orderNote.trim() || null,
          locationLat: deliveryLat,
          locationLng: deliveryLng,
          addressDetails,
          addressExtra,
          items: cart.map((item) => ({ id: item.id, quantity: item.quantity }))
        })
      });
      if (!response.ok) throw new Error("Order failed");
      setOrderNote("");
      setDeliveryLat(null);
      setDeliveryLng(null);
      setDeliveryAddress("");
      setAddrKvartira("");
      setAddrKirish("");
      setAddrQavat("");
      setAddrDomofon("");
      const telegram = (window as any).Telegram?.WebApp;
      if (telegram?.showAlert) {
        telegram.showAlert(t.success, () => { setCart([]); telegram.close(); });
        return;
      }
      setCart([]);
    } catch {
      setError(t.errorOrder);
    } finally {
      setLoading(false);
    }
  }

  function renderProductCard(product: Product, opts?: { showHeart?: boolean }) {
    const cartItem = cart.find((item) => item.id === product.id);
    const stockLimit = product.stock ?? MAX_QTY;
    const outOfStock = stockLimit <= 0;
    const isLiked = likedIds.has(product.id);
    return (
      <div
        key={product.id}
        className={`product-card${outOfStock ? " out-of-stock" : ""}`}
        onClick={() => setSelectedProduct(product)}
      >
        <div className="product-image">
          <div className="image-placeholder">
            <HugeiconsIcon icon={Image03Icon} size={26} color="currentColor" strokeWidth={1.5} />
          </div>
        </div>
        {opts?.showHeart !== false && (
          <button
            className={`product-heart${isLiked ? " liked" : ""}`}
            onClick={(e) => toggleLike(product.id, e)}
            aria-label="Like"
          >
            {isLiked
              ? <HeartFilledIcon size={16} />
              : <HugeiconsIcon icon={FavouriteIcon} size={16} color="currentColor" strokeWidth={2} />
            }
          </button>
        )}
        <div className="product-details">
          <div className="product-name">{product.name}</div>
          <div className="product-price">{formatMoney(product.price, product.priceCurrency, lang)}</div>
        </div>
        <div className="card-action" onClick={(e) => e.stopPropagation()}>
          {cartItem ? (
            <div className="quantity-control">
              <button className="qty-btn" onClick={() => decrementQuantity(product.id)}>
                <HugeiconsIcon icon={Remove01Icon} size={18} color="currentColor" strokeWidth={2} />
              </button>
              {editingQuantity === product.id ? (
                <input
                  type="number"
                  className="qty-input"
                  value={cartItem.quantity}
                  autoFocus
                  onFocus={(e) => e.target.select()}
                  onChange={(e) => {
                    const val = parseInt(e.target.value) || 1;
                    updateQuantity(product.id, Math.max(1, val));
                  }}
                  onBlur={() => setEditingQuantity(null)}
                  onKeyDown={(e) => { if (e.key === "Enter") setEditingQuantity(null); }}
                />
              ) : (
                <span className="qty-value" onClick={() => setEditingQuantity(product.id)}>
                  {cartItem.quantity}
                </span>
              )}
              <button className="qty-btn" onClick={() => incrementQuantity(product.id)} disabled={cartItem.quantity >= stockLimit}>
                <HugeiconsIcon icon={Add01Icon} size={18} color="currentColor" strokeWidth={2} />
              </button>
            </div>
          ) : (
            <button className="add-btn" onClick={() => addToCart(product)} disabled={stockLimit <= 0}>
              {outOfStock ? (
                t.outOfStock
              ) : (
                <HugeiconsIcon icon={Add01Icon} size={20} color="currentColor" strokeWidth={1.5} />
              )}
            </button>
          )}
        </div>
      </div>
    );
  }

  // Tab bar nav helper
  function navigateTab(tabId: string) {
    if (tabId === "cart") {
      setView("cart");
    } else {
      setView(tabId as View);
    }
  }

  const tabs = [
    { id: "home",    icon: Home01Icon,       label: t.tabHome },
    { id: "catalog", icon: GridViewIcon,     label: t.tabCatalog },
    { id: "cart",    icon: ShoppingCart01Icon, label: t.tabCart },
    { id: "saved",   icon: FavouriteIcon,    label: t.tabSaved },
    { id: "profile", icon: User02Icon,       label: t.tabProfile },
  ];

  // Determine active tab
  const activeTab =
    view === "home" ? "home" :
    view === "catalog" || view === "catalog-group" ? "catalog" :
    view === "cart" || view === "delivery-select" ? "cart" :
    view === "saved" ? "saved" :
    view === "profile" || view === "order-detail" ? "profile" :
    "home";

  // All products (for saved view)
  const allProducts = useMemo(() => Object.values(groupedProducts).flat(), [groupedProducts]);
  const savedProducts = useMemo(() => allProducts.filter((p) => likedIds.has(p.id)), [allProducts, likedIds]);

  return (
    <div className="app">
      <header className={`app-header${searchOpen && view === "home" ? " search-open" : ""}`}>
        {/* Left: back button or spacer */}
        {["catalog-group", "cart", "delivery-select", "order-detail"].includes(view) ? (
          <button
            className="icon-button back-button"
            onClick={() => {
              if (view === "cart") setView("home");
              else if (view === "delivery-select") setView("cart");
              else if (view === "catalog-group") setView("catalog");
              else if (view === "order-detail") setView("profile");
            }}
            aria-label="Back"
          >
            <HugeiconsIcon icon={ArrowLeft02Icon} size={22} color="currentColor" strokeWidth={1.5} />
          </button>
        ) : (
          <div className="header-spacer" />
        )}

        <h1 className="app-title">
          <span key={titleKey} className={`title-text title-${titlePhase}`}>
            {titleDisplay}
          </span>
        </h1>

        {/* Right: context button */}
        {view === "home" ? (
          <div ref={headerSearchRef} className={`header-search${searchOpen ? " expanded" : ""}`}>
            <button className="hs-icon" onClick={() => setSearchOpen(true)} aria-label="Search">
              <HugeiconsIcon icon={Search01Icon} size={20} color="currentColor" strokeWidth={1.5} />
            </button>
            <input
              ref={searchInputRef}
              type="text"
              className="hs-input"
              placeholder={t.search}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && closeSearch()}
            />
            <button className="hs-close" onClick={closeSearch} aria-label="Close search">
              <HugeiconsIcon icon={Delete02Icon} size={16} color="currentColor" strokeWidth={1.5} />
            </button>
          </div>
        ) : view === "cart" ? (
          <button className="icon-button" onClick={clearCart} disabled={cart.length === 0}>
            <HugeiconsIcon icon={Delete02Icon} size={22} color="currentColor" strokeWidth={1.5} />
          </button>
        ) : (
          <div style={{ width: 44 }} />
        )}
      </header>

      {/* Loading user info */}
      {userInfoLoading && (
        <section className="products">
          <div className="loading"><span className="spinner" /></div>
        </section>
      )}

      {/* Not registered */}
      {!userInfoLoading && !userInfo?.isRegistered && (
        <section className="products">
          <div className="empty-state">
            <HugeiconsIcon icon={InboxIcon} size={48} color="currentColor" strokeWidth={1.5} />
            <div className="muted">
              {!telegramId ? t.notDetected : t.notRegistered}
            </div>
          </div>
        </section>
      )}

      {/* ===== HOME VIEW ===== */}
      {!userInfoLoading && userInfo?.isRegistered && view === "home" && (
        <section className="products has-tabbar">
          {error && (
            <div className="error-block">
              <HugeiconsIcon icon={InboxIcon} size={48} color="currentColor" strokeWidth={1.5} />
              <div>{error}</div>
              <button className="retry-button" onClick={retryLoad}>
                {t.retry}
              </button>
            </div>
          )}
          {loadingCategories || (loadingGrouped && categoriesWithItems.length === 0) ? (
            <div className="loading">
              <span className="spinner" />
            </div>
          ) : categoriesWithItems.length === 0 && !error ? (
            <div className="empty-state">
              <HugeiconsIcon icon={InboxIcon} size={48} color="currentColor" strokeWidth={1.5} />
              <div className="muted">{t.emptyProducts}</div>
              <button className="retry-button" onClick={retryLoad}>
                {t.retry}
              </button>
            </div>
          ) : searchQuery.trim() ? (
            <>
              <div className="category-items">
                {flatFilteredProducts.map((product) => renderProductCard(product))}
              </div>
              {loadingGrouped && <div className="loading-more"><span className="spinner-sm" /></div>}
            </>
          ) : (
            <>
              {filteredCategoriesWithItems.map((category) => {
                const items = filteredGroupedProducts[category.id] || [];
                if (!items.length) return null;
                const sortedItems = [...items].sort((a, b) => {
                  const stockDelta = Number(isOutOfStock(a)) - Number(isOutOfStock(b));
                  if (stockDelta !== 0) return stockDelta;
                  return a.name.localeCompare(b.name);
                });
                return (
                  <div key={category.id} id={`cat-${category.id}`} className="category-group">
                    <div className="category-title">
                      {category.name}
                      <span className="category-count">{sortedItems.length}</span>
                    </div>
                    <div className="category-items">
                      {sortedItems.map((product) => renderProductCard(product))}
                    </div>
                  </div>
                );
              })}
              {loadingGrouped && <div className="loading-more"><span className="spinner-sm" /></div>}
            </>
          )}
        </section>
      )}

      {/* ===== CATALOG VIEW ===== */}
      {!userInfoLoading && userInfo?.isRegistered && view === "catalog" && (
        <section className="products has-tabbar">
          {loadingCategories || (loadingGrouped && categoriesWithItems.length === 0) ? (
            <div className="loading"><span className="spinner" /></div>
          ) : (
            <>
              {categoriesWithItems.map((cat) => (
                <div
                  key={cat.id}
                  className="catalog-card"
                  onClick={() => {
                    setSelectedCatalogCategory(cat);
                    setView("catalog-group");
                  }}
                >
                  <span className="catalog-card-name">{cat.name}</span>
                  <span className="catalog-count">{groupedProducts[cat.id]?.length ?? 0}</span>
                  <HugeiconsIcon icon={ArrowRight01Icon} size={18} color="currentColor" strokeWidth={1.5} />
                </div>
              ))}
              {loadingGrouped && <div className="loading-more"><span className="spinner-sm" /></div>}
            </>
          )}
        </section>
      )}

      {/* ===== CATALOG GROUP VIEW ===== */}
      {!userInfoLoading && userInfo?.isRegistered && view === "catalog-group" && selectedCatalogCategory && (
        <section className="products has-tabbar">
          {(() => {
            const items = groupedProducts[selectedCatalogCategory.id] || [];
            const sortedItems = [...items].sort((a, b) => {
              const stockDelta = Number(isOutOfStock(a)) - Number(isOutOfStock(b));
              if (stockDelta !== 0) return stockDelta;
              return a.name.localeCompare(b.name);
            });
            if (!sortedItems.length) {
              return (
                <div className="empty-state">
                  <HugeiconsIcon icon={InboxIcon} size={48} color="currentColor" strokeWidth={1.5} />
                  <div className="muted">{t.emptyProducts}</div>
                </div>
              );
            }
            return (
              <div className="category-items">
                {sortedItems.map((product) => renderProductCard(product))}
              </div>
            );
          })()}
        </section>
      )}

      {/* ===== CART VIEW ===== */}
      {!userInfoLoading && userInfo?.isRegistered && view === "cart" && (
        <section className="cart-page">
          {cart.length === 0 ? (
            <div className="empty-state">
              <HugeiconsIcon icon={InboxIcon} size={48} color="currentColor" strokeWidth={1.5} />
              <div className="muted">{t.emptyCart}</div>
              <button className="retry-button" onClick={() => setView("home")}>
                {t.browse}
              </button>
            </div>
          ) : (
            <div className="cart-section">
              <div className="cart-items">
                {cart.map((item) => (
                  <CartItemWrapper key={item.id} leaving={leavingItems.has(item.id)}>
                    <div className="cart-item" onClick={() => setSelectedProduct(item)}>
                      <div className="cart-item-info">
                        <div className="cart-item-name">{item.name}</div>
                        <div className="cart-item-price">{formatMoney(item.price * item.quantity, item.priceCurrency, lang)}</div>
                      </div>
                      <div className={`quantity-control-small ${bouncingItem === item.id ? "bounce" : ""}`} onClick={(e) => e.stopPropagation()}>
                        <button className="qty-btn-small" onClick={() => decrementQuantity(item.id)}>
                          <HugeiconsIcon icon={Remove01Icon} size={16} color="currentColor" strokeWidth={2} />
                        </button>
                        {editingQuantity === item.id ? (
                          <input
                            type="number"
                            className="qty-input-small"
                            value={item.quantity}
                            autoFocus
                            onFocus={(e) => e.target.select()}
                            onChange={(e) => {
                              const val = parseInt(e.target.value) || 1;
                              updateQuantity(item.id, Math.max(1, val));
                            }}
                            onBlur={() => setEditingQuantity(null)}
                            onKeyDown={(e) => { if (e.key === "Enter") setEditingQuantity(null); }}
                          />
                        ) : (
                          <span className="qty-value-small" onClick={() => setEditingQuantity(item.id)}>
                            {item.quantity}
                          </span>
                        )}
                        <button className="qty-btn-small" onClick={() => incrementQuantity(item.id)} disabled={item.quantity >= (item.stock ?? MAX_QTY)}>
                          <HugeiconsIcon icon={Add01Icon} size={16} color="currentColor" strokeWidth={2} />
                        </button>
                      </div>
                    </div>
                  </CartItemWrapper>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {/* ===== DELIVERY SELECT VIEW ===== */}
      {!userInfoLoading && userInfo?.isRegistered && view === "delivery-select" && (
        <section className="cart-page">
          <div className="delivery-select">
            <div className="delivery-select-options">
              <button
                className={`delivery-option-btn${selectedDeliveryMethod === "pickup" ? " selected" : ""}`}
                disabled={loading}
                onClick={() => setSelectedDeliveryMethod("pickup")}
              >
                <span className="delivery-option-icon">
                  <HugeiconsIcon icon={StoreLocation02Icon} size={20} color="currentColor" strokeWidth={1.6} />
                </span>
                <span className="delivery-option-label">{t.pickup}</span>
              </button>
              <button
                className={`delivery-option-btn${selectedDeliveryMethod === "delivery" ? " selected" : ""}`}
                disabled={loading}
                onClick={() => setSelectedDeliveryMethod("delivery")}
              >
                <span className="delivery-option-icon">
                  <HugeiconsIcon icon={DeliverySent02Icon} size={20} color="currentColor" strokeWidth={1.6} />
                </span>
                <span className="delivery-option-label">{t.delivery}</span>
              </button>
            </div>
            {selectedDeliveryMethod === "pickup" && (
              <div className="order-note">
                <label className="order-note-label" htmlFor="orderNote">{t.orderNoteLabel}</label>
                <textarea
                  id="orderNote"
                  className="order-note-input"
                  rows={3}
                  value={orderNote}
                  onChange={(e) => setOrderNote(e.target.value)}
                  placeholder={t.orderNotePlaceholder}
                />
              </div>
            )}
            {selectedDeliveryMethod === "delivery" && (
              <div className="delivery-form">
                <div className="address-field">
                  <label className="order-note-label">{t.fullAddressLabel}</label>
                  <button
                    className="address-picker"
                    onClick={() => setMapDrawerOpen(true)}
                    type="button"
                  >
                    <span className={`address-picker-text${deliveryAddress ? " filled" : ""}`}>
                      {deliveryAddress || t.fullAddressPlaceholder}
                    </span>
                  </button>
                </div>
                <div className="address-grid">
                  <div className="address-field">
                    <label className="order-note-label" htmlFor="addrKvartira">{t.kvartiraLabel}</label>
                    <input
                      id="addrKvartira"
                      className="address-input"
                      type="text"
                      value={addrKvartira}
                      onChange={(e) => setAddrKvartira(e.target.value)}
                      placeholder={t.kvartiraPlaceholder}
                    />
                  </div>
                  <div className="address-field">
                    <label className="order-note-label" htmlFor="addrKirish">{t.kirishLabel}</label>
                    <input
                      id="addrKirish"
                      className="address-input"
                      type="text"
                      value={addrKirish}
                      onChange={(e) => setAddrKirish(e.target.value)}
                      placeholder={t.kirishPlaceholder}
                    />
                  </div>
                  <div className="address-field">
                    <label className="order-note-label" htmlFor="addrQavat">{t.qavatLabel}</label>
                    <input
                      id="addrQavat"
                      className="address-input"
                      type="text"
                      value={addrQavat}
                      onChange={(e) => setAddrQavat(e.target.value)}
                      placeholder={t.qavatPlaceholder}
                    />
                  </div>
                  <div className="address-field">
                    <label className="order-note-label" htmlFor="addrDomofon">{t.domofonLabel}</label>
                    <input
                      id="addrDomofon"
                      className="address-input"
                      type="text"
                      value={addrDomofon}
                      onChange={(e) => setAddrDomofon(e.target.value)}
                      placeholder={t.domofonPlaceholder}
                    />
                  </div>
                </div>
                <div className="order-note">
                  <label className="order-note-label" htmlFor="deliveryNote">{t.orderNoteLabel}</label>
                  <textarea
                    id="deliveryNote"
                    className="order-note-input"
                    rows={3}
                    value={orderNote}
                    onChange={(e) => setOrderNote(e.target.value)}
                    placeholder={t.orderNotePlaceholder}
                  />
                </div>
              </div>
            )}
            {error && <div className="error-block"><div>{error}</div></div>}
          </div>
        </section>
      )}

      {/* ===== SAVED VIEW ===== */}
      {!userInfoLoading && userInfo?.isRegistered && view === "saved" && (
        <section className="products has-tabbar">
          {savedProducts.length === 0 ? (
            <div className="empty-state">
              <HugeiconsIcon icon={FavouriteIcon} size={48} color="currentColor" strokeWidth={1.5} />
              <div className="muted">{t.emptySaved}</div>
            </div>
          ) : (
            <div className="category-items">
              {savedProducts.map((product) => renderProductCard(product))}
            </div>
          )}
        </section>
      )}

      {/* ===== PROFILE VIEW ===== */}
      {!userInfoLoading && userInfo?.isRegistered && view === "profile" && (
        <section className="products has-tabbar">
          {/* User info card */}
          <div className="profile-card">
            {(userInfo.counterpartyName || userInfo.firstName) && (
              <div className="profile-name">{userInfo.counterpartyName || userInfo.firstName}</div>
            )}
            {userInfo.phoneNumber && (
              <div className="profile-phone">{userInfo.phoneNumber}</div>
            )}
            {userInfo.balance !== undefined && (
              <div className="profile-balance">
                {t.balance}: {formatMoney(userInfo.balance, userInfo.balanceCurrency, lang)}
              </div>
            )}
          </div>

          {/* Orders list */}
          <div className="profile-section-title">{t.ordersTitle}</div>
          {ordersLoading ? (
            <div className="loading"><span className="spinner" /></div>
          ) : orders.length === 0 ? (
            <div className="muted" style={{ textAlign: "center", padding: "20px 0" }}>—</div>
          ) : (
            orders.map((order) => (
              <div
                key={order.id}
                className="order-row"
                onClick={() => openOrderDetail(order.id, order.name)}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="order-row-name">{order.name}</div>
                  <div className="order-row-date">{formatDate(order.moment)}</div>
                  {order.state && <div className="order-row-state">{order.state}</div>}
                </div>
                <div className="order-row-sum">{formatMoney(order.sum, userInfo.balanceCurrency || null, lang)}</div>
                <HugeiconsIcon icon={ArrowRight01Icon} size={18} color="currentColor" strokeWidth={1.5} />
              </div>
            ))
          )}
        </section>
      )}

      {/* ===== ORDER DETAIL VIEW ===== */}
      {!userInfoLoading && userInfo?.isRegistered && view === "order-detail" && (
        <section className="cart-page">
          {orderDetailLoading ? (
            <div className="loading"><span className="spinner" /></div>
          ) : orderDetail ? (
            <>
              {/* Order info */}
              <div className="order-detail-info">
                {orderDetail.order.state?.name && (
                  <div className="order-detail-field">
                    <span className="order-detail-field-label">{t.orderStatus}</span>
                    <span className="order-detail-field-value">{orderDetail.order.state.name}</span>
                  </div>
                )}
                {orderDetail.order.moment && (
                  <div className="order-detail-field">
                    <span className="order-detail-field-label">{t.orderDate}</span>
                    <span className="order-detail-field-value">{formatDate(orderDetail.order.moment)}</span>
                  </div>
                )}
                {orderDetail.deliveryMethod && (
                  <div className="order-detail-field">
                    <span className="order-detail-field-label">{t.orderDelivery}</span>
                    <span className="order-detail-field-value">
                      {orderDetail.deliveryMethod === "pickup" ? t.pickup : orderDetail.deliveryMethod === "delivery" ? t.delivery : orderDetail.deliveryMethod}
                    </span>
                  </div>
                )}
                {orderDetail.addressText && (
                  <div className="order-detail-field">
                    <span className="order-detail-field-label">{t.orderAddress}</span>
                    <span className="order-detail-field-value">{orderDetail.addressText}</span>
                  </div>
                )}
                {orderDetail.addressExtra && (() => {
                  const parsed = parseAddressExtra(orderDetail.addressExtra);
                  return (
                    <>
                      {parsed.kvartira && (
                        <div className="order-detail-field">
                          <span className="order-detail-field-label">{t.kvartiraLabel}</span>
                          <span className="order-detail-field-value">{parsed.kvartira}</span>
                        </div>
                      )}
                      {parsed.kirish && (
                        <div className="order-detail-field">
                          <span className="order-detail-field-label">{t.kirishLabel}</span>
                          <span className="order-detail-field-value">{parsed.kirish}</span>
                        </div>
                      )}
                      {parsed.qavat && (
                        <div className="order-detail-field">
                          <span className="order-detail-field-label">{t.qavatLabel}</span>
                          <span className="order-detail-field-value">{parsed.qavat}</span>
                        </div>
                      )}
                      {parsed.domofon && (
                        <div className="order-detail-field">
                          <span className="order-detail-field-label">{t.domofonLabel}</span>
                          <span className="order-detail-field-value">{parsed.domofon}</span>
                        </div>
                      )}
                    </>
                  );
                })()}
                {orderDetail.driverInfo?.model && (
                  <div className="order-detail-field">
                    <span className="order-detail-field-label">{t.orderCarModel}</span>
                    <span className="order-detail-field-value">{orderDetail.driverInfo.model}</span>
                  </div>
                )}
                {orderDetail.driverInfo?.number && (
                  <div className="order-detail-field">
                    <span className="order-detail-field-label">{t.orderCarNumber}</span>
                    <span className="order-detail-field-value">{orderDetail.driverInfo.number}</span>
                  </div>
                )}
                {orderDetail.order.description && (
                  <div className="order-detail-field">
                    <span className="order-detail-field-label">{t.orderNoteLabel}</span>
                    <span className="order-detail-field-value">{orderDetail.order.description}</span>
                  </div>
                )}
              </div>

              {/* Positions */}
              {orderDetail.positions.length > 0 && (
                <div className="order-positions">
                  {orderDetail.positions.map((pos: any, i: number) => (
                    <div key={i} className="order-position-row">
                      <span className="order-position-name">{pos.name}</span>
                      <span className="order-position-qty">×{pos.quantity}</span>
                      {pos.price != null && (
                        <span className="order-position-sum">
                          {formatMoney(pos.price * pos.quantity, userInfo.balanceCurrency || null, lang)}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Total */}
              {typeof orderDetail.order.sum === "number" && (
                <div className="order-total">
                  {t.orderTotal}: {formatMoney(orderDetail.order.sum / 100, userInfo.balanceCurrency || null, lang)}
                </div>
              )}

              {/* Paid / Due */}
              {!!orderDetail.paidAmount && orderDetail.paidAmount > 0 && (
                <div className="order-detail-field">
                  <span className="order-detail-field-label">{t.orderPaid}</span>
                  <span className="order-detail-field-value">{formatMoney(orderDetail.paidAmount, userInfo.balanceCurrency || null, lang)}</span>
                </div>
              )}
              {!!orderDetail.dueAmount && orderDetail.dueAmount > 0 && (
                <div className="order-detail-field">
                  <span className="order-detail-field-label">{t.orderDue}</span>
                  <span className="order-detail-field-value" style={{ color: "var(--tg-theme-destructive-text-color, #e53935)" }}>
                    {formatMoney(orderDetail.dueAmount, userInfo.balanceCurrency || null, lang)}
                  </span>
                </div>
              )}

              {/* Demand PDF buttons */}
              {Array.isArray(orderDetail.order.demands) && orderDetail.order.demands.length > 0 && (
                <>
                  <div className="profile-section-title">{t.demands}</div>
                  {orderDetail.order.demands.map((demand: any) => {
                    const demandId: string | null = demand?.id || null;
                    if (!demandId) return null;
                    const isThisLoading = loadingDemandId === demandId;
                    return (
                      <button
                        key={demandId}
                        className={`demand-pdf-btn${isThisLoading ? " demand-pdf-btn--loading" : ""}`}
                        onClick={() => requestDemandPdf(demandId)}
                        disabled={!!loadingDemandId}
                      >
                        {isThisLoading && <span className="button-spinner" />}
                        <span className="demand-pdf-name">{isThisLoading ? t.processing : (demand.name || demandId)}</span>
                        {!isThisLoading && typeof demand.sum === "number" && (
                          <span className="demand-pdf-sum">
                            {formatMoney(demand.sum / 100, userInfo.balanceCurrency || null, lang)}
                          </span>
                        )}
                        {!isThisLoading && <span className="demand-pdf-icon">📄</span>}
                      </button>
                    );
                  })}
                </>
              )}
            </>
          ) : null}
        </section>
      )}

      {/* Product Sheet */}
      {userInfo?.isRegistered && selectedProduct && (
        <ProductSheet
          product={selectedProduct}
          categoryName={selectedProductCategory?.name ?? ""}
          cartItem={cart.find((i) => i.id === selectedProduct.id)}
          bouncingItem={bouncingItem}
          editingQuantity={editingQuantity}
          setEditingQuantity={setEditingQuantity}
          onClose={() => setSelectedProduct(null)}
          onAdd={(p) => { addToCart(p); }}
          onIncrement={incrementQuantity}
          onDecrement={decrementQuantity}
          onUpdateQuantity={updateQuantity}
          lang={lang}
          t={{ add: t.add, outOfStock: t.outOfStock }}
          isLiked={likedIds.has(selectedProduct.id)}
          onToggleLike={(e) => toggleLike(selectedProduct.id, e)}
        />
      )}

      {/* Bottom pay button — only in cart and delivery-select */}
      {!userInfoLoading && userInfo?.isRegistered && bottomVisible && (view === "cart" || view === "delivery-select") && (
        <div className={`app-bottom${bottomLeaving ? " leaving" : ""}`}>
          <button
            className="pay-button"
            onClick={
              view === "delivery-select"
                ? () => {
                    if (!selectedDeliveryMethod) return;
                    if (selectedDeliveryMethod === "delivery") handleDeliverySubmit();
                    else handleCheckoutWithMethod(selectedDeliveryMethod);
                  }
                : () => setView("delivery-select")
            }
            disabled={
              loading ||
              (view === "delivery-select" && !selectedDeliveryMethod) ||
              (view === "delivery-select" && selectedDeliveryMethod === "delivery" && !deliveryLat)
            }
          >
            <span className="pay-button-content">
              {loading && <span className="button-spinner" />}
              {loading ? t.processing : t.checkout}
            </span>
            {view !== "delivery-select" && (
              <span className="pay-price">{formatMoney(total, totalCurrency, lang)}</span>
            )}
          </button>
        </div>
      )}

      {/* Bottom Tab Bar */}
      {!userInfoLoading && userInfo?.isRegistered && showTabBar && (
        <div className="bottom-tab-bar">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`tab-item${activeTab === tab.id ? " active" : ""}`}
              onClick={() => navigateTab(tab.id)}
            >
              {tab.id === "cart" && totalItems > 0 && (
                <div className="tab-badge">{totalItems > 99 ? "99+" : totalItems}</div>
              )}
              <HugeiconsIcon icon={tab.icon} size={22} color="currentColor" strokeWidth={1.6} />
              <span className="tab-item-label">{tab.label}</span>
            </div>
          ))}
        </div>
      )}

      {/* Map Drawer */}
      {mapDrawerOpen && (
        <MapDrawer
          lat={deliveryLat}
          lng={deliveryLng}
          address={deliveryAddress}
          onSelect={(lat, lng, address) => {
            setDeliveryLat(lat);
            setDeliveryLng(lng);
            setDeliveryAddress(address);
          }}
          onClose={() => setMapDrawerOpen(false)}
          t={{ save: t.save, selectOnMap: t.selectOnMap }}
        />
      )}
    </div>
  );
}
