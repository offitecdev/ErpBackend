"use strict";
/**
 * ── «ÜRÜN EKLE» IST DER WARENEINGANG (28.09.2026, Vorgabe Samet) ────────────
 *
 * «Hiç sormadan, proje teslim tarihi en önce olan ürünün siparişine otomatik
 *  çeksin stoktan.» Was im Depo über «Ürün ekle» eingebucht wird (Scan, Menge,
 * Seriennummer), ist der Wareneingang der Bestellungen, die auf diese Karte
 * warten. Das Depo kennt diese Bestellungen nicht — es gibt die Buchung hier
 * weiter; wer zuhört (heute die BOM der Produktion), schreibt sie der
 * Bestellung gut und meldet zurück, wohin sie ging. Anders als
 * `warehouseStockEvents` wartet das Depo auf die Antwort: die Oberfläche zeigt
 * sie gleich an («10 adet → SP-2026-010 mal kabulü · Geri al»).
 *
 * Die Karte selbst (Menge von Hand, Excel-Aktarım) ist eine Berichtigung und
 * kommt hier nie an.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.warehouseGoodsInHandler = exports.setWarehouseGoodsInHandler = exports.DEPOT_RECEIPT_PREFIX = exports.isGoodsInUndoInvalid = exports.goodsInUndoInvalid = exports.GOODS_IN_UNDO_INVALID = void 0;
/** Die Rücknahme passt nicht zu dem, was gebucht wurde (fremde oder verbrauchte Buchung). */
exports.GOODS_IN_UNDO_INVALID = 'GOODS_IN_UNDO_INVALID';
const goodsInUndoInvalid = (message) => Object.assign(new Error(message), { code: exports.GOODS_IN_UNDO_INVALID });
exports.goodsInUndoInvalid = goodsInUndoInvalid;
const isGoodsInUndoInvalid = (error) => error?.code === exports.GOODS_IN_UNDO_INVALID;
exports.isGoodsInUndoInvalid = isGoodsInUndoInvalid;
/** Kennungen der Depo-Buchungen beginnen mit «D» (Wareneingang «R», Depo-Seriennummer «S»). */
exports.DEPOT_RECEIPT_PREFIX = 'D';
let handler = null;
const setWarehouseGoodsInHandler = (next) => {
    handler = next;
};
exports.setWarehouseGoodsInHandler = setWarehouseGoodsInHandler;
const warehouseGoodsInHandler = () => handler;
exports.warehouseGoodsInHandler = warehouseGoodsInHandler;
//# sourceMappingURL=warehouseGoodsIn.js.map