import { readFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfmake = require("pdfmake");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const vfsFonts = require("pdfmake/build/vfs_fonts");
// Load bundled Roboto fonts into the virtual filesystem and register them
const _vfs = vfsFonts as Record<string, string>;
Object.keys(_vfs).forEach((name) => {
  pdfmake.virtualfs.writeFileSync(name, _vfs[name], "base64");
});
pdfmake.addFonts({
  Roboto: {
    normal: "Roboto-Regular.ttf",
    bold: "Roboto-Medium.ttf",
    italics: "Roboto-Italic.ttf",
    bolditalics: "Roboto-MediumItalic.ttf"
  }
});

// ── Custom fonts (Noto Sans — full Unicode incl. Uzbek Cyrillic/Latin) ────────
const _dirPdf = dirname(fileURLToPath(import.meta.url));
const _fontsDir = join(_dirPdf, "../assets/fonts");

let _fontName = "Roboto";
try {
  const _notoR  = join(_fontsDir, "NotoSans-Regular.ttf");
  const _notoB  = join(_fontsDir, "NotoSans-Bold.ttf");
  const _notoI  = join(_fontsDir, "NotoSans-Italic.ttf");
  const _notoBI = join(_fontsDir, "NotoSans-BoldItalic.ttf");
  if (existsSync(_notoR) && existsSync(_notoB)) {
    pdfmake.virtualfs.writeFileSync("NotoSans-Regular.ttf",    readFileSync(_notoR));
    pdfmake.virtualfs.writeFileSync("NotoSans-Bold.ttf",       readFileSync(_notoB));
    pdfmake.virtualfs.writeFileSync("NotoSans-Italic.ttf",     existsSync(_notoI)  ? readFileSync(_notoI)  : readFileSync(_notoR));
    pdfmake.virtualfs.writeFileSync("NotoSans-BoldItalic.ttf", existsSync(_notoBI) ? readFileSync(_notoBI) : readFileSync(_notoB));
    pdfmake.addFonts({
      NotoSans: {
        normal:      "NotoSans-Regular.ttf",
        bold:        "NotoSans-Bold.ttf",
        italics:     "NotoSans-Italic.ttf",
        bolditalics: "NotoSans-BoldItalic.ttf"
      }
    });
    _fontName = "NotoSans";
  }
} catch {
  // Font files not available — Roboto fallback
}

// ── Logo (optional) ───────────────────────────────────────────────────────────
const _logoPath = join(_dirPdf, "../assets/logo.jpg");
let _logoDataUrl: string | null = null;
try {
  if (existsSync(_logoPath)) {
    _logoDataUrl = `data:image/jpeg;base64,${readFileSync(_logoPath).toString("base64")}`;
  }
} catch {
  // Logo not available — text fallback will be used
}

export type DemandPosition = {
  name: string;
  quantity: number;
  price: number | null;
  remainingQty?: number | null;
  remainingSum?: number | null;
};

export type DemandPdfParams = {
  demand: {
    id: string;
    name: string;
    moment?: string;
    sum?: number;
    state?: { name?: string };
  };
  positions: DemandPosition[];
  client: {
    firstName?: string | null;
    lastName?: string | null;
    phoneNumber?: string | null;
  };
  lang: string;
  currencyCode: string | null;
  balanceBefore?: number | null;
  balanceAfter?: number | null;
  leftToPay?: number | null;
  deliveryAddress?: string | null;
};

// ── Localised labels ──────────────────────────────────────────────────────────

function labels(lang: string) {
  if (lang === "ru") {
    return {
      docType: "ОТГРУЗКА",
      client: "Клиент",
      name: "Имя",
      phone: "Телефон",
      items: "Товары",
      colNo: "№",
      colName: "Наименование",
      colQty: "Кол-во",
      colPrice: "Цена",
      colTotal: "Сумма",
      colRemainingQty: "Остаток",
      colRemainingSum: "Остаток суммы",
      remainingShort: "Осталось",
      grandTotal: "Итого",
      status: "Статус",
      generated: "Документ сформирован",
      deliveryAddress: "Адрес доставки",
      balanceBefore: "Баланс до отгрузки",
      demandAmount: "Сумма отгрузки",
      leftToPay: "Осталось к оплате",
      balanceAfter: "Итоговый баланс"
    };
  }
  if (lang === "uzc") {
    return {
      docType: "ЖЎНАТИЛДИ",
      client: "Мижоз",
      name: "Исм",
      phone: "Телефон",
      items: "Маҳсулотлар",
      colNo: "№",
      colName: "Номи",
      colQty: "Миқдор",
      colPrice: "Нарх",
      colTotal: "Жами",
      colRemainingQty: "Қолди",
      colRemainingSum: "Қолган сумма",
      remainingShort: "Қолган",
      grandTotal: "Жами",
      status: "Ҳолат",
      generated: "Ҳужжат тузилди",
      deliveryAddress: "Йетказиб бериш манзили",
      balanceBefore: "Юборишдан олдинги баланс",
      demandAmount: "Юклама суммаси",
      leftToPay: "Қолган тўлов",
      balanceAfter: "Якуний баланс"
    };
  }
  // uz default
  return {
    docType: "YUBORILDI",
    client: "Mijoz",
    name: "Ism",
    phone: "Telefon",
    items: "Mahsulotlar",
    colNo: "№",
    colName: "Nomi",
    colQty: "Miqdor",
    colPrice: "Narx",
    colTotal: "Jami",
    colRemainingQty: "Qoldi",
    colRemainingSum: "Qolgan summa",
    remainingShort: "Qolgan",
    grandTotal: "Jami",
    status: "Holat",
    generated: "Hujjat tuzildi",
    deliveryAddress: "Yetkazib berish manzili",
    balanceBefore: "Yuborishdan oldingi balans",
    demandAmount: "Yuklama summasi",
    leftToPay: "Qolgan to'lov",
    balanceAfter: "Yakuniy balans"
  };
}

// ── Status localisation ────────────────────────────────────────────────────────

function localizeStatus(rawStatus: string | undefined, lang: string): string {
  if (!rawStatus) return lang === "ru" ? "Не указан" : lang === "uzc" ? "Кўрсатилмаган" : "Noma'lum";
  const n = rawStatus.trim().toLowerCase();
  const map: Record<string, { uz: string; uzc: string; ru: string }> = {
    "подтвержден":  { uz: "Tasdiqlandi",   uzc: "Тасдиқланди",   ru: "Подтверждён" },
    "подтверждено": { uz: "Tasdiqlandi",   uzc: "Тасдиқланди",   ru: "Подтверждён" },
    "собирается":   { uz: "Yig'ilmoqda",   uzc: "Йиғилмоқда",    ru: "Собирается"  },
    "отгружен":     { uz: "Yuklandi",      uzc: "Юкланди",       ru: "Отгружен"    },
    "отгружено":    { uz: "Yuklandi",      uzc: "Юкланди",       ru: "Отгружен"    },
    "доставляется": { uz: "Yetkazilmoqda", uzc: "Йетказилмоқда", ru: "Доставляется"},
    "отменен":      { uz: "Bekor qilindi", uzc: "Бекор қилинди", ru: "Отменён"     },
    "отменено":     { uz: "Bekor qilindi", uzc: "Бекор қилинди", ru: "Отменён"     },
    "новый":        { uz: "Yangi",         uzc: "Янги",          ru: "Новый"       },
    "выполнен":     { uz: "Bajarildi",     uzc: "Бажарилди",     ru: "Выполнен"    },
  };
  const entry = map[n];
  if (entry) return lang === "ru" ? entry.ru : lang === "uzc" ? entry.uzc : entry.uz;
  return rawStatus;
}

// ── Number formatters ─────────────────────────────────────────────────────────

function fmtDate(moment?: string): string {
  if (!moment) return "";
  const d = new Date(moment.replace(" ", "T"));
  if (isNaN(d.getTime())) return moment;
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${dd}.${mm}.${yyyy}  ${hh}:${min}`;
}

function fmtMoney(amount: number, currency: string | null): string {
  const code = (currency || "").toUpperCase();
  const rounded = Math.round(amount * 100) / 100;
  const text = rounded.toLocaleString("ru-RU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  const label =
    code === "USD" ? "USD" :
    code === "EUR" ? "EUR" :
    code === "RUB" ? "руб." :
    code === "UZS" ? "сум" :
    code || "";
  return label ? `${text} ${label}` : text;
}

function fmtQty(q: number): string {
  const r = Math.round(q * 100) / 100;
  return Number.isInteger(r) ? String(r) : r.toFixed(2);
}

// ── Filename helper ───────────────────────────────────────────────────────────

export function makePdfFilename(demand: { name: string; moment?: string }): string {
  const safeName = demand.name.replace(/[\\/:*?"<>|]/g, "_");
  if (demand.moment) {
    const d = new Date(demand.moment.replace(" ", "T"));
    if (!isNaN(d.getTime())) {
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      const hh = String(d.getHours()).padStart(2, "0");
      const min = String(d.getMinutes()).padStart(2, "0");
      return `${safeName}_${yyyy}-${mm}-${dd}_${hh}-${min}.pdf`;
    }
  }
  return `${safeName}.pdf`;
}

// ── Primary export ────────────────────────────────────────────────────────────

const BRAND_COLOR = "#1565C0";
const LIGHT_BLUE   = "#E3F2FD";
const TABLE_ALT    = "#F8FAFB";
const GREY_TEXT    = "#666666";

export function generateDemandPdf(params: DemandPdfParams): Promise<Buffer> {
  const { demand, positions, client, lang, currencyCode, balanceBefore, balanceAfter, leftToPay, deliveryAddress } = params;
  const L = labels(lang);

  const hasRemaining = positions.some(
    (pos) => (typeof pos.remainingQty === "number" && pos.remainingQty > 0)
      || (typeof pos.remainingSum === "number" && pos.remainingSum > 0)
  );

  const clientName = [client.firstName, client.lastName].filter(Boolean).join(" ") || "—";
  const clientPhone = client.phoneNumber || "—";

  const total = demand.sum != null
    ? demand.sum
    : positions.reduce((s, p) => s + (p.price ?? 0) * p.quantity, 0);

  const statusText = localizeStatus(demand.state?.name, lang);
  const dateText   = fmtDate(demand.moment);

  // ── Header content (logo = white layout; no logo = blue band) ────────────
  const headerContent: any[] = _logoDataUrl
    ? [
        {
          columns: [
            { image: _logoDataUrl, fit: [80, 80], width: 90 },
            {
              stack: [
                { text: "TX Electronics", fontSize: 18, bold: true, color: BRAND_COLOR },
                { text: demand.name, fontSize: 13, bold: true, color: "#333333", margin: [0, 3, 0, 0] },
                { text: L.docType, fontSize: 9, color: GREY_TEXT, characterSpacing: 2, margin: [0, 5, 0, 0] }
              ],
              alignment: "right" as const
            }
          ],
          margin: [0, 0, 0, 8]
        },
        {
          canvas: [{ type: "line", x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 2, lineColor: BRAND_COLOR }],
          margin: [0, 0, 0, 10]
        }
      ]
    : [
        {
          canvas: [
            { type: "rect", x: 0, y: 0, w: 515, h: 52, r: 4, color: BRAND_COLOR }
          ],
          absolutePosition: { x: 40, y: 40 }
        },
        {
          columns: [
            { text: [
                { text: "TX Electronics\n", fontSize: 18, bold: true, color: "#ffffff" },
                { text: L.docType, fontSize: 9, color: LIGHT_BLUE, characterSpacing: 2 }
              ]
            },
            { text: demand.name, fontSize: 16, bold: true, color: "#ffffff", alignment: "right" as const }
          ],
          margin: [8, 0, 8, 0]
        },
        { text: "\n" }
      ];

  // ── Table rows ──────────────────────────────────────────────────────────────
  const headerRow = [
    { text: L.colNo,    bold: true, color: "#fff", fillColor: BRAND_COLOR, alignment: "center" as const, margin: [4, 5, 4, 5] },
    { text: L.colName,  bold: true, color: "#fff", fillColor: BRAND_COLOR, margin: [4, 5, 4, 5] },
    { text: L.colQty,   bold: true, color: "#fff", fillColor: BRAND_COLOR, alignment: "center" as const, margin: [4, 5, 4, 5] },
    { text: L.colPrice, bold: true, color: "#fff", fillColor: BRAND_COLOR, alignment: "right" as const,  margin: [4, 5, 4, 5] },
    { text: L.colTotal, bold: true, color: "#fff", fillColor: BRAND_COLOR, alignment: "right" as const,  margin: [4, 5, 4, 5] },
    ...(hasRemaining ? [
      { text: L.colRemainingQty, bold: true, color: "#fff", fillColor: BRAND_COLOR, alignment: "center" as const, margin: [4, 5, 4, 5] },
      { text: L.colRemainingSum, bold: true, color: "#fff", fillColor: BRAND_COLOR, alignment: "right" as const,  margin: [4, 5, 4, 5] }
    ] : []),
  ];

  const dataRows = positions.map((pos, idx) => {
    const fill = idx % 2 === 0 ? null : TABLE_ALT;
    const lineTotal = pos.price != null ? pos.price * pos.quantity : null;
    return [
      { text: String(idx + 1), alignment: "center" as const, fillColor: fill, margin: [4, 4, 4, 4] },
      { text: pos.name,                                        fillColor: fill, margin: [4, 4, 4, 4] },
      { text: fmtQty(pos.quantity), alignment: "center" as const, fillColor: fill, margin: [4, 4, 4, 4] },
      { text: pos.price != null ? fmtMoney(pos.price, currencyCode) : "—", alignment: "right" as const, fillColor: fill, margin: [4, 4, 4, 4] },
      { text: lineTotal != null ? fmtMoney(lineTotal, currencyCode) : "—", alignment: "right" as const,  fillColor: fill, margin: [4, 4, 4, 4] },
      ...(hasRemaining ? [
        { text: typeof pos.remainingQty === "number" ? fmtQty(pos.remainingQty) : "â€”", alignment: "center" as const, fillColor: fill, margin: [4, 4, 4, 4] },
        { text: typeof pos.remainingSum === "number" ? fmtMoney(pos.remainingSum, currencyCode) : "â€”", alignment: "right" as const,  fillColor: fill, margin: [4, 4, 4, 4] }
      ] : []),
    ];
  });

  const remainingSumTotal = hasRemaining
    ? positions.reduce((sum, pos) => (typeof pos.remainingSum === "number" ? sum + pos.remainingSum : sum), 0)
    : null;

  const remainingTotalValue =
    leftToPay !== null && leftToPay !== undefined
      ? leftToPay
      : (remainingSumTotal ?? 0);

  const totalRow = [
    { text: "", fillColor: null },
    { text: "", fillColor: null },
    { text: "", fillColor: null },
    { text: L.grandTotal, bold: true, alignment: "right" as const, fillColor: LIGHT_BLUE, margin: [4, 8, 4, 6] },
    { text: fmtMoney(total, currencyCode), bold: true, fontSize: 11, alignment: "right" as const, fillColor: LIGHT_BLUE, color: BRAND_COLOR, margin: [4, 8, 4, 6] },
    ...(hasRemaining ? [
      { text: L.remainingShort, bold: true, alignment: "right" as const, fillColor: LIGHT_BLUE, margin: [4, 8, 4, 6] },
      { text: fmtMoney(remainingTotalValue, currencyCode), bold: true, fontSize: 11, alignment: "right" as const, fillColor: LIGHT_BLUE, color: BRAND_COLOR, margin: [4, 8, 4, 6] }
    ] : []),
  ];

  const docDefinition: any = {
    pageSize: "A4",
    pageMargins: [40, 50, 40, 60],
    defaultStyle: { font: _fontName, fontSize: 10, color: "#333333" },

    content: [
      // ── Header ────────────────────────────────────────────────────────────
      ...headerContent,

      // ── Date & status row ─────────────────────────────────────────────────
      {
        columns: [
          { text: dateText, color: GREY_TEXT, fontSize: 9 },
          {
            text: [
              { text: L.status + ": ", color: GREY_TEXT, fontSize: 9 },
              { text: statusText, bold: true, fontSize: 9, color: BRAND_COLOR }
            ],
            alignment: "right" as const
          }
        ],
        margin: [0, 4, 0, 12]
      },

      // ── Client info box ───────────────────────────────────────────────────
      {
        table: {
          widths: ["*"],
          body: [[
            {
              stack: [
                { text: L.client, bold: true, fontSize: 10, color: BRAND_COLOR, margin: [0, 0, 0, 4] },
                {
                  columns: [
                    { text: L.name + ":", color: GREY_TEXT, width: 60 },
                    { text: clientName, bold: true }
                  ]
                },
                {
                  columns: [
                    { text: L.phone + ":", color: GREY_TEXT, width: 60 },
                    { text: clientPhone }
                  ],
                  margin: [0, 2, 0, 0]
                }
              ],
              fillColor: LIGHT_BLUE,
              border: [false, false, false, false],
              margin: [12, 8, 12, 8]
            }
          ]]
        },
        margin: [0, 0, 0, 16]
      },

      // ── Products section ──────────────────────────────────────────────────
      { text: L.items, bold: true, fontSize: 11, color: BRAND_COLOR, margin: [0, 0, 0, 6] },
      {
        table: {
          headerRows: 1,
          widths: hasRemaining ? [22, "*", 48, 78, 78, 48, 78] : [22, "*", 52, 90, 90],
          body: [headerRow, ...dataRows, totalRow]
        },
        layout: {
          hLineWidth: () => 0,
          vLineWidth: () => 0
        }
      },

      // ── Spacer ────────────────────────────────────────────────────────────
      { text: "\n" },

      // ── Delivery address + balance section ────────────────────────────────
      ...(() => {
        const rows: any[][] = [];
        if (deliveryAddress) {
          rows.push([
            { text: L.deliveryAddress + ":", color: GREY_TEXT, width: 160 },
            { text: deliveryAddress, bold: true }
          ]);
        }
        if (balanceBefore !== null && balanceBefore !== undefined) {
          rows.push([
            { text: L.balanceBefore + ":", color: GREY_TEXT, width: 160 },
            { text: fmtMoney(balanceBefore, currencyCode) }
          ]);
        }
        if (total) {
          rows.push([
            { text: L.demandAmount + ":", color: GREY_TEXT, width: 160 },
            { text: fmtMoney(total, currencyCode) }
          ]);
        }
        if (leftToPay !== null && leftToPay !== undefined) {
          rows.push([
            { text: L.leftToPay + ":", color: GREY_TEXT, width: 160 },
            { text: fmtMoney(leftToPay, currencyCode) }
          ]);
        }
        if (balanceAfter !== null && balanceAfter !== undefined) {
          rows.push([
            { text: L.balanceAfter + ":", color: GREY_TEXT, width: 160 },
            { text: fmtMoney(balanceAfter, currencyCode), bold: true, color: BRAND_COLOR }
          ]);
        }
        if (rows.length === 0) return [];
        return [
          {
            canvas: [{ type: "line", x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 1, lineColor: "#E0E0E0" }],
            margin: [0, 0, 0, 10]
          },
          {
            table: {
              widths: ["*"],
              body: [[{
                stack: rows.map((row, i) => ({
                  columns: row,
                  margin: [0, i === 0 ? 0 : 3, 0, 0]
                })),
                fillColor: LIGHT_BLUE,
                border: [false, false, false, false],
                margin: [12, 10, 12, 10]
              }]]
            },
            margin: [0, 0, 0, 0]
          }
        ];
      })()
    ],

    // ── Footer ────────────────────────────────────────────────────────────────
    footer: (currentPage: number, pageCount: number) => ({
      columns: [
        { text: `${L.generated}: ${new Date().toLocaleDateString("ru-RU")}`, color: GREY_TEXT, fontSize: 8 },
        { text: `${currentPage} / ${pageCount}`, alignment: "right" as const, color: GREY_TEXT, fontSize: 8 }
      ],
      margin: [40, 10, 40, 0]
    }),

    styles: {}
  };

  return pdfmake.createPdf(docDefinition).getBuffer();
}
