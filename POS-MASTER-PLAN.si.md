# හෝටල් / ආහාර ව්‍යාපාර POS සහ සම්පූර්ණ කළමනාකරණ පද්ධතිය — ප්‍රධාන සැලැස්ම

සකස් කළ දිනය: 2026-10-17 · වේලා කලාපය: Asia/Colombo · සැලසුම් අනුවාදය: 1.0

මෙය development ආරම්භ කිරීමට භාවිත කළ හැකි requirements, architecture, delivery සහ verification සැලැස්මකි.
දැනට software එක implement කර නැත.

## 1. එකඟ වී ඇති අවශ්‍යතා සහ සැලසුම් පදනම

- කෑම සකස් කර විකුණන ව්‍යාපාරයක්; ශාඛා කිහිපයක් පාලනය කිරීම.
- Phone, tablet, laptop, desktop යන ඕනෑම උපකරණයක නවීන browser එකෙන් භාවිත කිරීම. Windows, Android, iPhone/iPad, macOS සහ Linux සඳහා responsive interface එකක්.
- Cashier, waiter, kitchen, stores, manager සහ owner සඳහා වෙන වෙනම වැඩ තිර සහ අවසර.
- Internet නැති වුවත් ශාඛාවේ දෛනික POS, kitchen, cash සහ stock කටයුතු කරගෙන යාම.
- Internet ලැබුණු විට Google Firebase Realtime Database වෙත ආරක්ෂිතව sync වීම.
- වැරදීමකින් මැකීම, උපකරණ හානි සහ දත්ත වැරදීම්වලින් නැවත ගොඩගත හැකි ස්වාධීන backups.
- Sinhala ප්‍රධාන UI; English සහ Tamil භාෂා සඳහා translation සැකැස්ම. මුදල් ඒකකය මුලින් LKR.
- මෙහි “හෝටලය” යනු ආහාර ව්‍යාපාරයයි. කාමර වෙන්කිරීම්/PMS අවශ්‍ය නම් පසුව වෙනම scope එකක් ලෙස එකතු කළ හැක.

තවම තීරණය කර නැති branch ගණන, printers, bills/day, users සහ integrations සඳහා පහත යෝජිත defaults භාවිත කර ඇත. මෙය මිල ගණනක් හෝ නියත delivery පොරොන්දුවක් නොවේ.
delivery පොරොන්දුවක් අවශ්‍යනම් සකස් කර ලබාදිය හැක.

## 2. ප්‍රධාන තාක්ෂණික තීරණය

**Responsive PWA + එක් ශාඛාවකට local branch hub + SQLite + Firebase Realtime Database** යන ආකෘතිය යෝජනා කරයි.

PWA යනු browser එකෙන් භාවිත කරන, සහාය දක්වන උපකරණවල app එකක් වගේ install කරගත හැකි web application එකකි. Cashier සඳහා විශාල buttons/keyboard shortcuts, phone සඳහා touch layout, kitchen සඳහා queue display ලබාදෙයි. Install කිරීම සහ peripheral පහසුකම් browser අනුව වෙනස් වන නිසා browser access මූලික සහාය වේ.

```text
ශාඛාව A                                      ශාඛාව B
Phone / Tablet / Cashier / Kitchen            Phone / Tablet / Cashier / Kitchen
              | local Wi-Fi / LAN                          | local Wi-Fi / LAN
     Local HTTPS Branch Hub A                    Local HTTPS Branch Hub B
       SQLite + outbox + print queue               SQLite + outbox + print queue
              |                                              |
              +--------- internet ලැබුණු විට ----------------+
                                     |
                         Authenticated Cloud Sync API
                         validate / deduplicate / acknowledge
                                     |
                               Realtime Database
                                     |
                      Owner / Head-office browser dashboard

වෙනම ආරක්ෂාව: local snapshots -> දෙවැනි උපකරණයක්
              cloud snapshots -> වෙනම backup storage
```

**Branch hub** යනු එම ශාඛාවේ දත්ත සුරකින, orders එකිනෙක ගැටීම පාලනය කරන කුඩා local service එකකි. මුලදී cashier PC එකේ background service එකක් ලෙස ධාවනය කළ හැක. උපකරණ කිහිපයක්/වැඩි bills ඇති ශාඛාවකට UPS සහිත dedicated mini-PC එකක් වඩා සුදුසුය.

එක් ශාඛාවක active orders, payments සහ physical stock සඳහා ලියන ප්‍රධාන authority එක hub එක පමණි. Cloud එක ශාඛා අතර තොරතුරු බෙදාගැනීම, head-office commands, reporting සහ cloud copy සඳහා යොදාගනී. Hub එකට නොදැන mobile එකෙන් cloud එකට එම bill එක settle කරන දෙවන මාර්ගයක් තබන්නේ නැත. ඕනෑම browser device එකක් client ලෙස භාවිත කළ හැකි වුවත් එය ස්වයංක්‍රීයව branch hub එක වෙනුවට server එකක් නොවේ; hub සඳහා සුදුසු PC/mini-PC එකක් අවශ්‍යය.

Realtime Database Web RTDB SDK එකේ offline writes browser session එකෙන් පිටත persist නොවන බව නිල ලේඛනය සඳහන් කරයි. එම නිසා SDK cache එක පමණක් restaurant financial records සඳහා ප්‍රමාණවත් නොවේ. මෙහි ස්ථිර local database සහ custom sync protocol යෝජනා කරන්නේ එම සීමාව නිසාය. [Firebase: Web read/write සහ offline behavior](https://firebase.google.com/docs/database/web/read-and-write)

## 3. ඕනෑම උපකරණයක භාවිතය සහ offline හැසිරීම

| තත්ත්වය | කළ හැකි වැඩ | පැහැදිලිව පෙන්විය යුතු සීමාව |
|---|---|---|
| Internet සහ branch LAN දෙකම ඇත | සියලු branch operations, cloud sync, owner reports | ශාඛා අනුව අවසර අදාළ වේ |
| Internet නැත; branch LAN ඇත | Cash bills, orders, KDS, receipts, production, local stock, shifts | Cloud reports පසුගිය sync තෙක් පමණි; external services සීමා වේ |
| Phone එකට mobile internet ඇත; branch hub වෙත සම්බන්ධයක් නැත | Owner reports/central functions අදාළ අවසර අනුව; order drafts | Shared branch bill එක cloud හරහා ස්වාධීනව settle නොකරයි |
| Internet සහ branch LAN දෙකම නැත | කලින් load කළ menu බලන්න; තම device එකේ unconfirmed drafts තබන්න | Kitchen වෙත යවා ඇත/මුදල් ගෙවා ඇත ලෙස තහවුරු නොකරයි |
| Hub PC එක restart/හානි වී ඇත | Existing drafts බලන්න; recovery හෝ controlled standby procedure | උපකරණ දෙකක් එකවර branch authority නොකරයි |
| අලුත් device එකක්; පළමු වතාවේ network නැත | කලින් app/data/credentials නැති නිසා initial setup කළ නොහැක | පළමු device enrollment සඳහා online authorization අවශ්‍යය; කලින් අනුමත device එකකට branch LAN හරහා app/data නැවත ලබාගත හැක |

**“Offline” යන්නෙන් internet නැති වීම සහ ශාඛාවේ Wi-Fi/LAN නැති වීම වෙන වෙනම හඳුනාගනී.** සියලු උපකරණ එකිනෙකටත් වෙන්වී තිබියදී එකම shared bill/stock එක නිවැරදිව එකවර වෙනස් කිරීම පොරොන්දු කළ නොහැක. ඉහත සීමා භාවිත කර duplicate payments සහ overselling වළක්වයි.

Cloud owner dashboard එක ඕනෑම තැනකින් online භාවිත කළ හැක. Branch එක offline නම් “අවසන් sync: ...”, pending count සහ report එක provisional බව පෙන්වයි. Branch එකේ live data අවශ්‍ය remote command එක hub acknowledgement ලැබෙන තෙක් pending වේ.

## 4. Browser/PWA සහ local network සැකැස්ම

- එකම frontend build එක branch hub එකෙන් localව serve කිරීම; head office සඳහා cloud hosting. Menu, fonts, translations සහ app assets සඳහා අනිවාර්ය external CDN dependency නොතබයි.
- Branch එකට ස්ථිර HTTPS hostname එකක්, උදාහරණයක් ලෙස `br01.pos.example.com`; branch DNS එකෙන් hub LAN IP එකට resolve කරයි. QR code එකෙන් device setup/branch URL ලබාදෙයි.
- නිසි trusted TLS certificate එකක් කලින් provision කර expiry/renewal alerts තබයි. Local CA භාවිත කරන්නේ නම් සියලු උපකරණවල trust setup අවශ්‍යය. IP address එකක් මත සාමාන්‍ය HTTP පමණක් දී PWA offline පහසුකම් ඇතැයි සලකන්නේ නැත.
- Service worker එකෙන් app shell cache කරයි; IndexedDB/Dexie තුළ menu cache, device drafts, command IDs සහ pending state තබයි. Branch hub SQLite එක confirmed business records සඳහා ප්‍රධාන local store එකයි.
- Browser storage persist ඉල්ලීම, quota/eviction handling, private mode warning සහ unsent drafts alert තිබිය යුතුය. Cache clear/uninstall/device loss නිසා browser-only drafts නැති විය හැක.
- Branch URL සහ cloud URL වෙනම origins නම් caches/session වෙනස්ය; offline භාවිතයට branch URL කලින් setup කර තිබිය යුතුය.
- Cloud-hosted page එකෙන් arbitrary local HTTP hub එකකට සෑම browser එකකම සෘජුව සම්බන්ධ විය හැකැයි නොසලකයි. Browser/OS local-network permissions, CORS සහ mixed-content සීමා setup/spike එකේ පරීක්ෂා කරයි. Branch එකේ app සහ API එකම local HTTPS origin එකෙන් serve කිරීම default ක්‍රමයයි.
- iOS/Android background execution එක මත අනිවාර්ය sync රඳා නොපවතී. App open/resume/reconnect වෙද්දී නැවත යැවීම; hub cloud sync එක background service එකෙන් සිදු කරයි.
- PWA updates shift අතර force reload නොකරයි; pending drafts ඉවත් නොවන migration සහ compatibility check අවශ්‍යය.

Service workers සඳහා secure context අවශ්‍ය වන අතර browser storage eviction හැසිරීම platform අනුව වෙනස් වේ. මේවා deployment acceptance checks ලෙස සලකයි. [MDN: Service Workers](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API), [MDN: Storage quotas සහ eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria), [Chrome: Local Network Access](https://developer.chrome.com/blog/local-network-access)

## 5. සම්පූර්ණ modules

| Module | ඇතුළත් වැඩ |
|---|---|
| Business / branches | ශාඛා, counters, stores, tables, kitchen stations, opening hours, branch prices, business date |
| Staff / permissions | Users, branch access, roles, shifts, device registration, manager approvals, audit |
| Menu / pricing | Categories, pictures, item codes/barcodes, variants, extras, combos, promotions, price schedules, sold-out |
| Cashier POS | Dine-in, takeaway, token, pickup, delivery, hold/resume, split/merge bills, discounts, taxes/service charges |
| Waiter | Table map, guests/seats, notes, order entry, kitchen send, served status, table transfer |
| Kitchen / KOT | Station routing, preparation queue, timers, accept/preparing/ready/served, change/cancel tickets |
| Payments / receipts | Cash, card, QR/bank, split tender, partial payments, vouchers, credit, receipts, reprints, refunds |
| Recipes / costing | Ingredients, subrecipes, unit conversions, recipe versions, yield, packaging, portion cost |
| Production | Daily plan, ingredient issue, cooked batches, actual yield, remaining portions, expiry/holding, waste |
| Inventory | Raw stock, prepared stock, resale goods, packaging, movements, batch/expiry, stock count, adjustments |
| Purchasing | Suppliers, request/approval, purchase order, GRN, partial delivery, invoice match, purchase return |
| Branch transfers | Request, dispatch, in-transit stock, partial receipt, discrepancy, return, transfer costs |
| Cash / expenses | Opening float, cash-in/out, petty cash, safe drops, counted cash, variance, close approval |
| Credit / supplier balances | Customer credit limits, receivables, supplier payables, payments, advances, ageing |
| Accounting | Chart of accounts, double-entry journals, bank reconciliation, trial balance, P&L, balance sheet, period lock |
| Customers | Optional contact details, order history, loyalty, vouchers, preferences, credit |
| Employees | Attendance, shifts, leave, employee meals, advances, tips; payroll extension |
| Management reports | Sales, margins, production, waste, stock, cash, purchasing, branch comparisons, exports |
| System operations | Sync status, conflicts, backup/restore, audit, health alerts, updates, support diagnostics |

Customer online ordering, catering/events, reservations, payment gateway integration, delivery-platform integration, payroll සහ advanced forecasting පසුව එක් කළ හැකි extensions වේ. Core architecture සහ data model ඒවාට ඉඩ තබයි.

## 6. Users, roles සහ approval controls

| Role | ප්‍රධාන අවසර |
|---|---|
| Owner | සියලු ශාඛා සාරාංශ, policy, user access, approved sensitive actions |
| Head-office admin | Shared menu/recipes, branch configuration, central purchasing, rollout |
| Branch manager | තම ශාඛාව, shifts, approvals, stock counts, refunds, local exceptions |
| Cashier | Orders, payments, receipts, තම cash shift |
| Waiter | Tables/orders/KOT/served; refunds සහ accounts නැත |
| Kitchen | තම station tickets සහ preparation status |
| Storekeeper / production | GRN, stock movements, batches, waste; අදාළ approvals |
| Accountant | Ledgers, reconciliations, journals, closing periods, exports |
| Auditor | Read-only reports සහ audit trail |

Discount limit ඉක්මවීම, price override, paid bill void/refund, stock adjustment, credit sale, closed shift reopen සහ exceptional cash movement සඳහා permission + approver + reason අවශ්‍යය. Shared cashier account වෙනුවට එක් පුද්ගලයකුට අනන්‍ය login/PIN භාවිත කරයි.

## 7. Sales, kitchen සහ payments සඳහා නියමිත workflows

**දෛනික ආරම්භය:** hub/network/printer/backup health පරීක්ෂා කිරීම → opening float → cashier shift open → menu/availability/production තහවුරු කිරීම.

**Table order:** table තේරීම → items/variants/extras/notes → hub save → KOT queue → kitchen acknowledgement → preparing → ready → served → bill → payment → receipt. Local draft එක hub එක පිළිගන්නා තෙක් “Kitchen වෙත යැවීය” ලෙස නොපෙන්වයි.

**Takeaway:** items → token → අවශ්‍ය payment policy → kitchen → ready/collected. Order preparation status සහ payment status වෙන වෙනම තබයි.

**Bill changes:** split/merge/transfer සඳහා latest version check. Kitchen එකට කලින් යැවූ order වෙනස් කළ විට වෙනස පමණක් සහ පැහැදිලි cancel/change ticket එකක් යවයි. දැනට සකස් කළ කෑම cancel කළ විට waste/complimentary/approved return disposition තීරණය කරයි.

**Payment:** මුදල නැවත calculate කර validate කිරීම → unique payment command → hub transaction commit → receipt job. Tender ගණන වෙනම records ලෙස තබයි. Card/QR approval provider/terminal එකෙන් ලැබිය යුතුය; POS offline බව bank authorization ලබාදෙන්නේ නැත. තහවුරු නොකළ electronic payment එක pending/manual verification ලෙස වෙනම පෙන්වයි.

**Refund:** original sale/payment reference → remaining refundable amount check → permission/reason → reversal entry → provider refund අවශ්‍ය නම් settlement pending → refund receipt. ආපසු ලැබුණු පිසූ ආහාර ස්වයංක්‍රීයව sellable stock එකට නොදමයි.

**Shift close:** pending/unpaid bills පරීක්ෂා කිරීම → cash count → expected vs counted → variance explanation → manager sign-off → close report. Internet නැතිව local shift close කළ හැක; cloud report එක branch sync ලැබෙන තෙක් provisional වේ. මුළු company accounting period lock සඳහා සියලු branches reconcile කර තිබිය යුතුය.

Business date එක calendar date එකෙන් වෙන් කරයි. උදාහරණයට රාත්‍රී 12 පසු අවසන්වන shift එක අදාළ ව්‍යාපාරික දිනයටම අයත් වේ.

## 8. කෑම සකස් කිරීම, තොග සහ සැබෑ ලාභය

### 8.1 පෙර සකස් කරන කෑම — batch production

උදාහරණය: rice packets 100ක් සකස් කිරීමේදී හාල්/මස්/කුළුබඩු/packaging නිෂ්පාදන batch එකට issue කරයි. Actual output 100 ලෙස register කරයි. Packets 60ක් විකුණූ විට finished stock 40යි; waste 5ක් ලියාපදිංචි කළ විට ඉතිරි 35යි. විකිණීමේදී අමුද්‍රව්‍ය නැවත අඩු නොකරයි.

Production record එකට recipe version, planned/actual yield, actual ingredients, cost, unit/portion size, සකස් කළ වේලාව, holding/expiry limit, responsible employee සහ branch අවශ්‍යය. Holding rules ව්‍යාපාරයේ අනුමත ආහාර හැසිරවීමේ ක්‍රම අනුව configure කරයි.

### 8.2 ඇණවුමට අනුව හදන කෑම — made to order

Fried rice/kottu වැනි items සඳහා අමුද්‍රව්‍ය consumption එක තීරණය කළ preparation/fulfilment අවස්ථාවේ එක වරක් post කරයි. Draft item add/remove කරන සෑම අවස්ථාවකම physical stock අඩු නොකරයි. Reserved demand සහ consumed stock වෙන් කර පෙන්වයි.

Subrecipe එකක්, උදාහරණයට curry base එකක්, කලින් batch ලෙස සකස් කළේ නම් අවසන් කෑම සඳහා එම base stock consume කරයි; එහි මුල් අමුද්‍රව්‍ය නැවත consume නොකරයි.

### 8.3 Stock rules

- kg/g, litre/ml, pieces, packets සහ portions සඳහා නිශ්චිත conversions. Purchase unit සහ recipe unit වෙන් කරයි; quantities fixed precision decimal ලෙස සුරකියි.
- Raw ingredients, packaging, prepared food, resale goods සහ nonfood consumables වෙනම stock types.
- Sizes/variants, extras සහ combo components සඳහා නිශ්චිත recipe/prepared-stock mapping. Combo එකක් ලෙස විකුණන විට එහි component quantities එක වරක් පමණක් consume කරයි; extra egg වැනි එකතු කිරීම් වෙනම ගණනය කරයි.
- සෑම receipt/production/consumption/sale/waste/transfer/return/adjustment එකකටම stock ledger entry එකක්.
- Opening stock, reorder levels, low stock, expiry, stock count, stock variance සහ approved adjustment.
- Food waste, staff meals, tasting, complimentary items සහ damage සඳහා වෙනම reasons/costs.
- Physical picking සඳහා expiry අනුව FEFO; cost valuation සඳහා මුලින් moving weighted average යෝජනා කරයි. Accounting period lock පසු cost corrections reversal/adjustment ලෙස පෙන්වයි.
- Recipe theoretical usage vs actual stock variance සහ batch yield variance වාර්තා කරයි.
- Negative stock අවහිර කිරීම හෝ manager override කිරීම item/branch policy අනුව; override එක audit කරයි.
- Net sales − food cost = gross margin. Labour/rent/utility/commission වියදම් නොඅඩු කර එය net profit ලෙස නොපෙන්වයි.

### 8.4 Purchasing සහ transfers

Purchase request → approval → PO → GRN/quantity-quality check → supplier invoice match → payable → payment. Partial deliveries, purchase returns, advances සහ due dates ඇතුළත් වේ.

Branch transfer → request → approved dispatch → in-transit → receiver accepts actual quantity → discrepancy resolution. Units 50ක් යවා 48ක් ලැබුණොත් වෙනස 2ක් වෙනම record කරයි. Sending branch offline dispatch එකෙන් පමණක් receiving branch stock එක “received” නොකරයි. Internal transfer එක company sales revenue නොවේ.

## 9. Cash, expenses සහ සම්පූර්ණ accounting

- Opening float, cash payments, cash refunds, paid-in/out, safe drops, petty cash සහ cash drawer access log.
- Expected cash = opening float + cash sales + paid-in − cash refunds − paid-out − safe drops. Counted cash සමඟ variance report.
- Card/QR/bank සහ delivery-platform settlement register; commissions/fees/differences වෙනම reconciliation.
- Supplier payable/customer receivable ledgers, credit limits, ageing, advances සහ partial settlements.
- Expenses සඳහා category, branch, date, attachment, payment method සහ approval.
- සම්පූර්ණ accounting සඳහා chart of accounts, debit/credit postings, journals, trial balance, profit and loss, balance sheet, bank reconciliation සහ period locks.
- Sales, refunds, inventory cost, purchases, supplier payments සහ cash movements සඳහා accountant සමාලෝචිත posting rules. Draft example: cash sale සඳහා Dr Cash / Cr Sales; applicable tax liability වෙනම.
- Posted sale/journal record මකා නැවත ලියන්නේ නැත; reversal/correction entry එකක් භාවිත කරයි.
- Tax/service-charge rates, inclusive/exclusive pricing, discount allocation සහ rounding configurable වේ. ක්‍රියාත්මක කිරීමට පෙර ව්‍යාපාරයට අදාළ නීති/බදු සැකැස්ම accountant සමඟ තහවුරු කරයි; මෙහි නිශ්චිත බදු අනුපාතයක් උපකල්පනය කර නැත.

## 10. Sync protocol — data නැතිවීම සහ duplicate වීම වළක්වන ක්‍රමය

1. Device එක persistent `commandId` එකක් සාදා local draft/command එක save කර hub එකට යවයි. Network timeout නම් එම ID එකම නැවත භාවිත කරයි.
2. Hub එක device/user/branch permissions සහ expected order version පරීක්ෂා කරයි. Device එවන totals විශ්වාස නොකර hub එක නැවත calculate කරයි.
3. **එකම SQLite transaction එකේ** business record, money/stock ledger, immutable event, cloud outbox සහ අවශ්‍ය print job ලියයි. Commit සාර්ථක වූ පසු පමණක් cashier වෙත confirmed result දෙයි.
4. Hub worker එක pending events cloud API වෙත retries/backoff සමඟ යවයි. Unique ID එක වෙනස් නොකරයි. අවශ්‍ය අනුපිළිවෙළ සඳහා branch epoch + monotonically increasing sequence භාවිත කරයි.
5. Cloud API එක branch credential, schema, actor context, event ID, payload hash සහ sequence validate කරයි. දැනටමත් offline commit වූ sale එකකට අදාළ historical signed policy/lease පරීක්ෂා කරයි; අද user role වෙනස් වූ නිසා පරණ valid sale එක නිහඬව අවලංගු නොකරයි. Local clock එක පමණක් authorization proof නොවේ; සැක සහිත actions review කරයි. එකම event නැවත ආවොත් කලින් result ලබාදෙයි; එම ID එකට වෙනස් payload එකක් නම් conflict/reject කරයි.
6. Per-event bounded transaction එකකින් canonical ingest record සහ deduplication identity සුරකියි. Durable branch sequencing/fencing සහිත worker එකෙන් idempotent projections apply කරයි; deterministic record IDs සහ අවශ්‍ය per-aggregate conditional updates භාවිත කරයි. සියලු අදාළ business projections durable වූ පසු පමණක් cloud-applied result publish කරයි. Crash අතරමඟ නැවතුණොත් checkpoints වලින් නැවත ආරම්භ කරයි. විශාල analytical reports සඳහා වෙනම applied watermark පෙන්වයි.
7. Hub එක **cloud-applied acknowledgement** ලැබුණු පසු පමණක් outbox item synced ලෙස mark කරයි. Upload/send success එක පමණක් backup complete ලෙස පෙන්වන්නේ නැත.
8. Ack response නැතිවුණත් event එක නැවත යැවීමෙන් sale, stock හෝ payment දෙවරක් නොපෙන්විය යුතුය. Missing sequence gaps retry/resend මඟින් සොයාගනී. ස්ථිරව invalid event එකක් durable quarantine record එකක තබා එහි sequence disposition ලියාපදිංචි කරයි; එය silently applied නොකරයි. පසුව එන independent events ඉදිරියට යා හැකි අතර එම aggregate එකට dependent events repair වන තෙක් නවත්වයි.
9. Head-office changes වෙනම versioned commands ලෙස branch වෙත එයි. Hub ඒවා validate/apply කර acknowledgement දෙයි. Branch එක offline නම් menu/price/user change එක එම ශාඛාවේ ක්‍රියාත්මක වූ බව පෙන්වන්නේ නැත.
10. Quarantined/rejected events local records මකා දමා හෝ නිහඬව අතහැර දමා resolve නොකරයි. Transport-received/disposition සහ business-applied status වෙන් කරයි; unresolved exceptions backup/retention cleanup එකෙන් ඉවත් නොකරයි. Manager review, correction/reversal සහ audit අවශ්‍යය.

Transport එක නැවත යැවිය හැකි ආකාරයට සාදා, business effects idempotent කරයි. Network එකෙන් “exactly once delivery” පොරොන්දු නොකරයි. Firebase multi-location updates atomic වුවත් deduplication/sequence checks සහ concurrent writes සඳහා එය පමණක් ප්‍රමාණවත් නොවේ. මුළු වර්ධනය වන branch tree එකම transaction එකකින් read/write කිරීම හෝ autoscaling cloud instances අතර in-memory mutex එකක් පමණක් යොදාගැනීම නොකරයි. Bounded ingest, durable worker fencing සහ replay-safe projections phase-0 technical proof එකේ අනිවාර්ය gate එකකි. [Firebase: Atomic updates සහ transactions](https://firebase.google.com/docs/database/web/read-and-write), [Firebase: Retry සහ idempotency](https://firebase.google.com/docs/functions/retries)

### Conflict policies

| Data | Policy |
|---|---|
| Payment / refund / journal | Append-only ledger; unique commands/provider refs; remaining amount validate; last-write-wins නොකරයි |
| Open bill / table ownership | Hub transaction + expected version; conflict නම් latest state පෙන්වා user resolve කරයි |
| Stock | Movement entries; balance = ledger-derived; උපාංග දෙකක absolute balances overwrite නොකරයි |
| Menu / price / recipe | Head-office version + explicit branch override + effective time; old sale snapshots තබයි |
| Loyalty / global credit | Offline redemption අක්‍රිය කිරීම default; අවශ්‍ය නම් branch-allocated quotas පසුව |
| Cross-branch stock | Latest-known timestamp සමඟ; disconnected branches සඳහා global live guarantee නැත |
| Delete | Posted records සඳහා reversal; master data සඳහා archived/tombstone + version |

## 11. Data model සහ Firebase tree

### Local SQLite ප්‍රධාන tables

`businesses`, `branches`, `devices`, `staff`, `roles`, `role_policies`, `local_sessions`, `tables`, `tills`, `shifts`, `menu_items`, `item_variants`, `modifiers`, `price_versions`, `recipes`, `recipe_versions`, `recipe_lines`, `units`, `suppliers`, `purchase_orders`, `goods_receipts`, `supplier_invoices`, `production_batches`, `production_inputs`, `production_outputs`, `stock_movements`, `stock_counts`, `transfers`, `orders`, `order_lines`, `kitchen_tickets`, `payments`, `refunds`, `cash_movements`, `customers`, `credit_entries`, `accounts`, `journal_entries`, `journal_lines`, `audit_events`, `command_results`, `domain_events`, `outbox`, `inbox`, `print_jobs`, `sync_checkpoints`, `backup_runs`.

මූලික නියම: IDs සඳහා globally unique UUID; මුදල් integer minor units ලෙස, උදාහරණයට රු.125.50 = 12550; quantities fixed precision. Order එකේ item name, price, discounts, tax, recipe/cost versions යන historical snapshots තබයි. `occurredAt`, `hubRecordedAt`, `cloudReceivedAt` වෙන් කරයි; device clock එකෙන් financial order තීරණය නොකරයි. `businessDate`, `createdBy`, `branchId`, `version` සහ audit metadata අවශ්‍ය තැන්වල අනිවාර්යය.

### Cloud Realtime Database — යෝජිත bounded structure

```text
/businesses/{businessId}/branchRegistry/{branchId}
/businesses/{businessId}/masterData/{type}/{id}
/businesses/{businessId}/branches/{branchId}/events/{businessDate}/{eventId}
/businesses/{businessId}/branches/{branchId}/orders/{businessDate}/{orderId}
/businesses/{businessId}/branches/{branchId}/payments/{businessDate}/{paymentId}
/businesses/{businessId}/branches/{branchId}/stock/{locationId}/{itemId}
/businesses/{businessId}/branches/{branchId}/dailySummaries/{businessDate}
/businesses/{businessId}/branches/{branchId}/ingest/{eventId}
/businesses/{businessId}/branches/{branchId}/exceptions/{eventId}
/businesses/{businessId}/branches/{branchId}/sync/{epoch}
/businesses/{businessId}/branchCommands/{branchId}/{commandId}
/businesses/{businessId}/memberships/{userId}
```

මෙය design sketch එකකි; final transaction boundary, query patterns, membership lookups සහ indexing implementation design එකේ තහවුරු කරයි. Photos/receipts/supplier attachments Firebase RTDB තුළ base64 ලෙස නොතබයි; access-controlled object storage එකක තබා reference/hash සුරකියි.

Cloud listeners අවශ්‍ය branch/date/summary paths වලට සීමා කරයි. සියලු දත්ත root එකෙන් සෑම device එකකටම download නොකරයි. `.indexOn`, pagination, retention/archiving සහ summary projections භාවිත කරයි. විශාල historical analytics අවශ්‍ය වූ විට archive/analytics store එකකට export කරයි. [Firebase: Performance optimization](https://firebase.google.com/docs/database/usage/optimize)

Invoice display number එක `BR01-C02-S01-20261017-000123` වැනි unique branch/counter/receipt-series/business-date sequence එකක් විය හැක; internal UUID වෙනමය. Old backup restore හෝ standby promotion පසු කලින් නිකුත් වූ receipt counters නැවත භාවිත නොකරයි; වෙනස් authorized receipt series/counter namespace එකක් reserve කරයි. Offline recovery සඳහාත් වෙනම pre-authorized series ලබාදී actual numbering/accounting අවශ්‍යතා අවසන් setup එකේ තහවුරු කරයි.

### Event envelope සහ service boundaries

Event එකක `eventId`, `businessId`, `branchId`, `hubEpoch`, `branchSequence`, `deviceId`, `actorId`, `policyVersion`, `aggregateId`, `aggregateVersion`, `eventType`, `schemaVersion`, `occurredAt`, `payload`, `payloadHash` ඇත. Sensitive personal data අනවශ්‍ය ලෙස event payload/log තුළ නැවත නැවත නොදමයි.

Branch APIs: login/pair device, menu sync, create/change order, send KOT, update preparation, record payment/refund, stock/production movements, shift close, health/backup status. Cloud APIs: branch event batch ingest/status, master-data commands, authorized reports/admin operations. API contracts සඳහා shared schemas සහ compatible version range තබයි.

## 12. Security සහ offline login

- Cloud owner/head-office login සඳහා Firebase Authentication; high-privilege accounts සඳහා අමතර account protection/MFA capability setup අවස්ථාවේ තහවුරු කරයි.
- Staff local login සඳහා කලින් provision කළ branch account/PIN verifier සහ signed permission policy. PIN hashes, attempt limits, lockout, auto-lock සහ approver authentication අවශ්‍යය.
- යෝජිත offline policy refresh interval පැය 24යි; උපරිම පැය 72ක offline authorization lease එකක්. ඉන්පසු manager-controlled, කලින් provision කළ සීමිත emergency sales procedure භාවිත කරයි. Refund/permission elevation වැනි sensitive operations තහනම් හෝ අමතර අනුමැතියට යටත් කරයි. මේ values business policy ලෙස අවසන් කරයි.
- Cloud access revoke කළ පණිවිඩයක් offline branch එකකට වහාම ළඟාවෙන්නේ නැත. Lease expiry, reconnect enforcement සහ stale-policy actions review මඟින් එම අවදානම පාලනය කරයි.
- New cloud login/password reset, අලුත් roles/admin privileges සහ device enrollment සඳහා online authorization අවශ්‍යය. Firebase token තිබේය කියා අසීමිත offline cloud authorization ඇතැයි සලකන්නේ නැත.
- API තුළ business/branch/device scope validate කරයි; UI button hide කිරීම security නොවේ. Server-calculated totals සහ approval checks අනිවාර්යය.
- RTDB rules default-deny; authorized scoped reads පමණක්. Business clientsට canonical payments/events/master totals සෘජුව වෙනස් කිරීමට ඉඩ නොදෙයි. Mutations validated server API හරහා පමණි.
- Firebase Admin SDK සහ service-account private keys cloud backend එකේ පමණි. Browser/PWA/cashier/mobile/branch installer තුළ project-wide service-account JSON නොදමයි. Hub සඳහා revoke කළ හැකි branch-specific credential එකක් OS-protected storage එකක තබයි.
- Admin SDK rules bypass කරන නිසා cloud service එකෙත් authorization/validation අනිවාර්යය. Local device registration, sessions සහ replay prevention තබයි.
- HTTPS local සහ cloud; hub disk encryption/OS permissions; encrypted backups සහ recovery keys වෙනම ආරක්ෂිතව තබයි. SQLite තනිවම at-rest encryption ලබාදේ යැයි නොසලකයි.
- Public/guest Wi-Fi එකෙන් POS LAN එක වෙන් කරයි. Database file එක SMB/shared drive එකක සෘජුව devices කිහිපයකින් open නොකරයි.
- Card number/CVV සුරකින්නේ නැත; provider reference/token අවශ්‍ය ප්‍රමාණයට පමණි. Logs තුළ passwords/tokens/customer details mask කරයි.
- Dev/staging/production වෙනම environments; secrets source control එකේ නැත; audit සහ export permissions, backup permissions වෙනමයි.

මේ controls Firebase rules, authentication සහ key handling මත පදනම් වේ. [Firebase: Security rules](https://firebase.google.com/docs/database/security), [Firebase: Security checklist](https://firebase.google.com/support/guides/security-checklist), [Firebase: Admin SDK setup](https://firebase.google.com/docs/admin/setup), [Firebase: Sessions](https://firebase.google.com/docs/auth/admin/manage-sessions)

## 13. Backups, disaster recovery සහ දත්ත ආරක්ෂාව

**Sync සහ backup වෙනස්ය.** Sync වූ data එක වැරදීමකින් මැකුණොත්/වෙනස්වුණොත් එම වැරැද්ද cloud copy එකටත් යා හැක. පරණ අනුවාදයකට නැවත යා හැකි වෙනම backups අවශ්‍යය.

| ආරක්ෂක තට්ටුව | යෝජිත ක්‍රමය |
|---|---|
| Local transaction durability | SQLite transactions, foreign keys, WAL, financial commits සඳහා `synchronous=FULL`; UPS සහ disk health |
| Local backup | Online Backup API මඟින් consistent snapshot; විනාඩි 15කට වරක් සහ shift close වෙලාවේ encrypted backup එක දෙවැනි physical device/NAS එකකට |
| Cloud sync | Connectivity ඇති විට durable outbox එකෙන් events upload; applied acknowledgement සහ checkpoints |
| Cloud database backup | Blaze plan මත RTDB data සහ rules සඳහා daily automated Cloud Storage backups |
| වෙනත් assets | Attachments/media සඳහා වෙනම backup/versioning; Auth/config/device registry/rules/source recovery සැලැස්ම |
| Independent recovery | වෙනම access/retention policy සහිත off-site copy; backup writerට පරණ retained copies මකාදැමීමේ අවසර සීමා කිරීම |
| Restore drill | අවම වශයෙන් මාසිකව spare hub/test environment එකකට restore කර ledger totals තහවුරු කිරීම |

Live SQLite `.db` file එක පමණක් copy කිරීම backup ක්‍රමය නොවේ; WAL ඇතුළු consistency සඳහා Backup API භාවිත කරයි. SQLite WAL එක network filesystem මත නොතබයි. [SQLite: WAL සහ durability](https://www.sqlite.org/wal.html), [SQLite: Online Backup API](https://www.sqlite.org/backup.html)

Firebase native daily backups සඳහා Blaze plan අවශ්‍ය අතර Cloud Storage ගාස්තු අදාළය. එම backup එකෙන් local-only unsynced sales හෝ වෙනම media/Auth දත්ත ස්වයංක්‍රීයව ආරක්ෂා නොවේ. [Firebase: Automated backups](https://firebase.google.com/docs/database/backups)

**යෝජිත recovery ඉලක්ක:** සාමාන්‍ය සම්බන්ධතාවක cloud sync lag විනාඩි 5ට අඩු; hub disk එක සම්පූර්ණයෙන් අහිමිවී internet නැති විට දෙවන local backup copy එකෙන් විනාඩි 15 දක්වා data gap; සූදානම් spare hardware ඇති විට විනාඩි 60 ඇතුළත service restore. මේවා implementation/testing මඟින් තහවුරු කළ යුතු targets මිස guarantees නොවේ. Backup destination අක්‍රිය නම් හෝ සියලු offline copies එකවර නැති වුණොත් unsynced දත්ත නැතිවිය හැක. ශූන්‍ය data loss ඉලක්කයක් අවශ්‍ය නම් දෙවන durable replica එකකට commit acknowledgement ලබාදෙන වෙනම design එකක් අවශ්‍යය.

Retention default proposal: local 15-minute copies පැය 48; daily copies දින 30; cloud daily දින 30 සහ monthly copies මාස 12. Storage/financial retention අවශ්‍යතාව අනුව සංශෝධනය කරයි. Backup failures සහ stale backups owner/manager dashboard එකේ පෙන්වයි.

**Recovery අනුපිළිවෙළ:** old hub writers නවත්වන්න/fence කරන්න → අලුත් hub එක provision කරන්න → checksum/key/schema verify කර snapshot restore කරන්න → snapshot checkpoint පසු cloud-confirmed events replay කරන්න → ඉතිරි outbox original IDs සමඟ reconcile කරන්න → orders/payments/stock/cash totals compare කරන්න → නව hub epoch activate කරන්න → devices නැවත pair/reconnect කරන්න. Cloud එක නැති විට local verified snapshot එකෙන් සීමිත recovery ක්‍රමය භාවිත කර, cloud reconciliation පසුව සිදු කරයි.

Recovered pending events වල original `eventId`, `hubEpoch` සහ `branchSequence` වෙනස් නොකරයි. නව epoch එක ලැබෙන්නේ recovery පසු අලුතින් නිර්මාණය කරන transactions වලට පමණි; ඒවාට වෙනම receipt series එකත් යොදයි. Restore වී ඇති පැරණි events නව events ලෙස stamp කළොත් duplicate විය හැකි නිසා එය අවහිර කරයි. Transport/cloud නොමැති recovery එකේ පැරණි unresolved stream වෙනම තබා, reconnect වෙද්දී reconciliation අවශ්‍ය බව පෙන්වයි.

Automatic active-active hub failover නොකරයි. Network partition එකක hub දෙකක් bills settle කළොත් වැරදි ගනුදෙනු ඇතිවිය හැකි නිසා explicit standby promotion සහ old-hub fencing අනිවාර්යය.

## 14. Printers, cashier hardware සහ network

- එක් branch එකකට hub PC/mini-PC, local router/AP, wired connection, UPS සහ දෙවන backup destination.
- Cashier සඳහා 80mm thermal printer; kitchen station එකට thermal/KOT printer හෝ tablet KDS; USB/Ethernet models actual device test පසු තෝරයි.
- සියලු phones/browser වලින් printerට direct USB/Bluetooth access ඇතැයි උපකල්පනය නොකරයි. Hub print service එකෙන් OS/Ethernet printer වෙත යැවීම default ක්‍රමයයි. Barcode scanners සඳහා keyboard-input mode උපකරණ වඩා සරලයි.
- Sinhala/Tamil thermal text සඳහා printer font support හෝ raster image rendering actual hardware එකේ පරීක්ෂා කරයි. Receipt PDF/browser print fallback ලබාදෙයි.
- Print jobs persistent වේ; queued/sent/confirmed/unknown/failed තත්ත්ව වෙන් කරයි. Paper out/reboot/timeout පසු printer output එක නොදන්නා විට blind retry නොකර operatorට reprint option දී “COPY” ලෙස මුද්‍රණය කරයි.
- Print retry එක sale/payment/KOT production නැවත නිර්මාණය නොකරයි. Receipt number සහ ticket ID එකම තබයි.
- Cash drawer/scale/customer display සඳහා model-specific integration අවශ්‍ය විය හැක. Generic Bluetooth printer එකක් මිලදීගැනීමට පෙර iOS/Android/Windows සහ hub compatibility pilot එකේ තහවුරු කරයි.
- Device Wi-Fi isolation/private DNS/cellular fallback, TLS certificate expiry සහ LAN DNS behavior outage tests වලට ඇතුළත් කරයි.

Browser serial access සෑම platform එකකම තිබෙන පොදු පහසුකමක් නොවන නිසා hub printing යෝජනා කරයි. [MDN: Web Serial compatibility](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API)

## 15. Screens සහ භාවිත පහසුව

1. Login / branch selection / device pairing.
2. Role-specific home සහ branch/cloud connection status.
3. Cashier POS: categories, search, large item buttons, cart, extras, hold, pay.
4. Table map සහ waiter mobile order screen.
5. Kitchen queue: new/preparing/ready; station filter සහ timers.
6. Orders/bills, payment/reconciliation සහ refunds.
7. Production plan, ingredient issue, batch output, leftovers/waste.
8. Stock balance, movements, counts, transfers සහ expiry.
9. Purchasing, GRN, suppliers සහ payables.
10. Cash shift, expenses, close සහ variance approval.
11. Head-office dashboard, branch comparison සහ reports.
12. Recipes/pricing, users/permissions, accounting සහ settings.
13. Sync conflicts, backups/restore status, printers සහ system health.

සෑම screen එකකම relevant branch සහ business date පැහැදිලිව පෙන්වයි. Connection labels: `Device එකේ පමණයි`, `ශාඛාවේ සුරැකුණි`, `Cloud sync වෙමින්`, `Cloud applied`, `අවධානය අවශ්‍යයි`. වැරදි network indicator එකකින් payment save වී ඇතැයි නොපෙන්වයි. Small screens සඳහා essential actions මුල් තැනට; touch targets, keyboard access, contrast සහ readable Sinhala fonts තහවුරු කරයි.

## 16. Reports සහ management dashboard

- Branch/date/hour/channel/item/category/cashier අනුව sales; net sales, discounts, refunds, complimentary, tax/service charges වෙනම.
- Cash/card/QR/credit tender totals, pending electronic verification, settlement differences, shift variance.
- Production plan vs actual, batch yield, cooked portions remaining, leftovers, waste value සහ reasons.
- Raw/prepared stock, stock valuation, expiry, reorder, transfers in transit, count variance, recipe theoretical vs actual usage.
- Purchase prices, recipe cost changes, gross margin සහ branch operating profitability.
- Supplier/customer outstanding, ageing, expenses, journals, trial balance, P&L සහ balance sheet.
- Kitchen preparation time, late tickets, table turnover සහ channel demand.
- Voids/refunds/discount overrides, approvers, suspicious exceptions, unauthorized attempts සහ export history.
- සෑම branch එකේ last hub/cloud sync, pending/rejected events, stale reports, last verified backup සහ restore test.
- CSV/Excel/PDF exports සඳහා role/branch/date filters; data freshness සහ provisional status export එකටත් ඇතුළත් කරයි.

## 17. යෝජිත technology stack සහ folder සැකැස්ම

| කොටස | යෝජනාව |
|---|---|
| Universal UI | React + TypeScript + Vite; responsive layouts; Sinhala/English/Tamil translation resources |
| Offline browser store | IndexedDB + Dexie; service-worker app cache; versioned local migrations |
| Branch backend | Supported Node.js LTS + TypeScript + Fastify; local HTTPS API/WebSocket; service auto-start/watchdog |
| Branch database | SQLite local SSD; transactional writes, WAL, indexes, tested backup/restore |
| Cloud backend | Cloud Run හෝ Cloud Functions මත validated sync/admin APIs; Firebase Admin SDK server-side |
| Cloud data/auth | Firebase Realtime Database + Firebase Authentication; authorized file/object storage |
| Hosting | Cloud dashboard සඳහා Firebase Hosting; branch clients සඳහා hub-hosted same build |
| Checks | Unit/domain tests, integration tests, Firebase Emulator Suite, browser tests, failure/recovery tests |
| Release | Separate staging/production, pinned dependencies, signed/verifiable builds සහ migration rollback procedure |

Exact dependency versions development ආරම්භයේ supported releases වලින් pin කරයි. PWA framework/plugin තේරීමේදී iOS caching, offline updates සහ storage behavior spike එකේ පරීක්ෂා කරයි. [React](https://react.dev/learn), [Vite](https://vite.dev/guide/), [Dexie](https://dexie.org/docs), [Fastify](https://fastify.dev/docs/latest/)

```text
E:\hottle pos\
  POS-MASTER-PLAN.si.md
  apps\web\                   # එකම responsive PWA
  services\branch-hub\        # SQLite, LAN API, print, local auth
  services\cloud-api\         # validated sync සහ admin commands
  packages\contracts\         # schemas, API/event contracts
  packages\domain\            # pricing, payment, stock සහ accounting rules
  firebase\                   # rules, indexes, emulator configuration
  tests\                      # integration, E2E, outage/recovery cases
  deployment\                 # installers, service setup, release scripts
  docs\                       # setup, operations, data dictionary, runbooks
```

මෙම structure එක යෝජනාව පමණි; මේ අවස්ථාවේ application folders හෝ code සාදා නැත. Production database files source repo එකෙන් වෙන් කර OS-protected data directory එකක තබයි.

## 18. Development අදියර සහ ලබාදෙන ප්‍රතිඵල

| අදියර | ලබාදෙන ප්‍රතිඵල | අවසන් කළ බව තහවුරු කරන පරීක්ෂාව |
|---|---|---|
| 0 — discovery සහ technical spike | Branch/device/printer survey, workflows, UX prototype, HTTPS/LAN/PWA/print/sync proof | iPhone/Android/PC මත internet කපා local order → KOT → cash receipt demo |
| 1 — foundation | Users/roles/devices, branch hub, DB migrations, audit, durable commands/outbox, cloud ingest, backup prototype | Restart/duplicate command/no-WAN checks සහ verified restore |
| 2 — daily POS | Menu, tables, cashier/waiter/KDS, cash/card records, refunds, shifts, receipts | Pilot branch එකේ full service workflow සහ concurrent-payment check |
| 3 — food operations | Recipes, batches, stock ledger, GRN/purchases, waste, supplier balances, core reports | Production 100 → sale 60 → waste 5 = 35; costing/raw deduction check |
| 4 — multi-branch | Central versions, branch commands, transfers, consolidated reports, quotas/restrictions | Branches 2–3ක් වෙන වෙනම offline කර reconnect කර totals reconcile |
| 5 — financial completion | Customer/supplier credit, expenses, bank/payment reconciliation, double-entry accounting, locks | Accountant-approved sample journals සහ balanced trial balance |
| 6 — hardening සහ rollout | Security checks, outage/power/disk tests, restore runbooks, training, staged releases | පහත acceptance gates සහ supervised pilot shifts සමත් වීම |
| 7 — extensions | Loyalty, payroll, online orders, catering, gateways/delivery integrations | එක් integration එකකට වෙනම acceptance criteria |

Offline durability සහ cloud sync අවසාන අදියරකට ඉතිරි නොකරයි; foundation සිට සෑම අදියරකම test කරයි. පළමු live pilot එකට sales, cash close, basic cooked-food inventory, audit සහ verified backup/restore අවම වශයෙන් තිබිය යුතුය.

Planning allowance: පළපුරුදු developers දෙදෙනකු, QA/support සහ ව්‍යාපාරික තීරණ සඳහා නියෝජිතයකු සිටී නම් usable pilot සඳහා සති 8–12ක්; core multi-branch management සහ accounting ඇතුළත් සම්පූර්ණ rollout සඳහා සමස්ත සති 18–28ක් වැනි පරාසයක් වෙන් කළ හැක. මෙය preliminary estimate එකකි; survey/spike සහ integration scope පසු effort නැවත ගණනය කළ යුතුය. එක developer කෙනකු හෝ සංකීර්ණ external integrations තිබේ නම් වැඩි කාලයක් අවශ්‍ය විය හැක.

## 19. Implementation backlog — ප්‍රමුඛතාව

P0 = live භාවිතයට අනිවාර්ය; P1 = සම්පූර්ණ management rollout; P2 = එකතු කළ හැකි extensions.

| ID | වැඩ කොටස | ප්‍රමුඛතාව |
|---|---|---|
| F01 | Multi-branch data scope, IDs, devices, business dates, roles | P0 |
| F02 | Local hub + HTTPS/DNS + responsive PWA + durable device drafts | P0 |
| F03 | SQLite transactions, command dedupe, version checks, stock/money precision | P0 |
| F04 | Cloud event API, durable outbox/ack, retries, status/conflict queue | P0 |
| F05 | Menu/pricing, POS, tables, KDS/KOT, receipt/print queue | P0 |
| F06 | Cash/electronic tender records, refund/reversal, shift close | P0 |
| F07 | Recipes, cooked batches, raw/prepared stock, GRN, waste | P0 |
| F08 | Local/cloud backups, restore, offline auth, security/audit | P0 |
| M01 | Central menu/price versioning, branch transfer and consolidated reports | P1 |
| M02 | Purchase approvals, supplier/customer balances, reconciliation | P1 |
| M03 | Expenses, double-entry accounting, financial statements/period locks | P1 |
| M04 | Advanced food-cost/variance dashboards, employee operations | P1 |
| X01 | Loyalty/vouchers with safe redemption, reservations/catering | P2 |
| X02 | Payment gateway, online ordering, delivery integrations, payroll | P2 |

P0 පමණක් අවසන් වීම “full system” අවසන් වීම නොවේ; P1 deliverables ද ඇතුළත් විය යුතුය.

## 20. Live කිරීමට පෙර acceptance checklist

- [ ] Android Chrome, iPhone/iPad Safari, Windows Edge/Chrome, macOS Safari සහ Linux Chrome/Firefox සඳහා අනුමත browser matrix එක පරීක්ෂා කර ඇත; small phone, tablet, desktop layouts භාවිත කළ හැක.
- [ ] Internet පැය 24–72ක් කපා තබා branch LAN හරහා orders, KDS, cash payments, stock/production සහ shifts ක්‍රියා කරයි.
- [ ] WAN නැති cold launch/reboot, local DNS failure, browser LAN permission denied/revoked, locked phone resume සහ pending-draft app upgrade පරීක්ෂා කර ඇත.
- [ ] Cashier/hub/browser restart කළත් hub-confirmed sale/payment නැති නොවේ; unconfirmed drafts පැහැදිලිය.
- [ ] Commit/send/cloud apply/ack අතර process/power failure කර නැවත ධාවනය කළ විට duplicate sale/payment/stock movement නොමැත.
- [ ] එකම command/event 100 වතාවක් යැවුවත් එක business effect එකක් පමණි; වෙනස් payload සහිත same ID reject වේ.
- [ ] Cloud events අනුපිළිවෙළ වෙනස් කර/gaps දමා යැවූ විට නැතිවුණු events හඳුනාගෙන totals converge වේ.
- [ ] Invalid/stale-policy event එක quarantine වී independent later events ඉදිරියට යයි; dependent aggregates review තෙක් නවතී; historical valid offline sale අලුත් role change එකකින් නැති නොවේ.
- [ ] Cashiers දෙදෙනකු එකම bill එක pay කිරීමට උත්සාහ කළ විට duplicate full settlement වැළකේ; valid split/partial tender නිවැරදිය.
- [ ] Card timeout එක actual approval පසු ඇති කළ විට provider reference reconcile කරයි; blind re-charge නොකරයි.
- [ ] LAN/hub නැති phone එකෙන් paid/kitchen-confirmed බව වැරදියට නොපෙන්වයි; cloud එක දෙවන payment authority නොවේ.
- [ ] Packets 100 production → sales 60 → waste 5 පසු finished balance 35යි; raw ingredients එක වරක් පමණක් consume වී ඇත.
- [ ] Made-to-order සහ subrecipe consumption, order changes/cancellations නිවැරදි ledgers ලබාදෙයි.
- [ ] Prepared portions දෙකක් සහ extra egg එකක් සහිත combo එකක් විකුණූ විට අදාළ components පමණක් එක වරක් consume වේ; variant sizes cost/stock mapping නිවැරදිය.
- [ ] Branch transfer 50 dispatch / 48 received සඳහා in-transit/discrepancy units 2 නිවැරදිය.
- [ ] Branches 2–3ක් independently offline/reconnect කළ විට invoice IDs ගැටෙන්නේ නැත; branch data leak/overwrite නැත.
- [ ] Discount, refund, adjustment, credit සහ export permissions actual API requests වලින් පරීක්ෂා කර ඇත; approver/reason audit වේ.
- [ ] Offline user revocation/lease expiry සහ emergency manager procedure පරීක්ෂා කර ඇත.
- [ ] Printer paper-out/power failure පසු committed sale රැකේ; reprint “COPY” වේ; duplicate kitchen preparation නැත.
- [ ] Sinhala/Tamil receipt actual thermal printer එකේ කියවිය හැක; phone/browser printing restrictions හඳුනාගෙන ඇත.
- [ ] Overnight shift, tax/discount rounding, split bills, partial refund සහ closed-period correction නිවැරදිය.
- [ ] Disk full, missing backup destination, corrupted backup, expired certificate සහ stale sync සඳහා visible alert ඇත.
- [ ] Browser cache clear/storage failure පසු hub-confirmed data රැකේ; browser-only unsent draft සීමාව නිවැරදිව පෙන්වයි.
- [ ] Spare hub restore කර orders/payments/stock/cash/journals සහ checkpoints source records සමඟ reconcile කර ඇත; old hub fenced වේ.
- [ ] පරණ snapshot එකකින් offline restore කළත් කලින් නිකුත් වූ receipt numbers නැවත භාවිත නොවේ; recovered events original IDs/epoch/sequence සමඟ පමණක් replay වේ.
- [ ] Backups decrypt කිරීමට අවශ්‍ය recovery keys authorized owner සතුව ඇත; backup status පමණක් නොව restore drill evidence ඇත.
- [ ] Owner report එක offline branch data “live” ලෙස නොපෙන්වයි; freshness/provisional state exports තුළත් ඇත.
- [ ] Actual expected peak users/bills සහ අවම device එක අනුව load test කර ඇත. Provisional target: hub order/payment save p95 <1 second, confirmed KOT local delivery <2 seconds; hardware/network survey පසු final targets තීරණය කරයි.
- [ ] Accountant විසින් day close, stock valuation, journal samples සහ balanced trial balance අනුමත කර ඇත.

## 21. Deployment, training සහ භාරදීම

1. Menu/recipes/units, opening stock, suppliers, branch prices, staff roles, taxes සහ payment methods spreadsheet එකකින් සකස් කර verify කරයි.
2. Pilot branch එකකට network/hub/printers/backup destination setup කර device pairing සහ offline rehearsal කරයි.
3. Cashier, waiter, kitchen, storekeeper සහ manager සඳහා තම වැඩ පමණක් ආවරණය කරන පුහුණුව සහ Sinhala quick guides ලබාදෙයි.
4. Supervised live shifts කිහිපයක් අතර cash/stock/KOT/reports reconcile කර issues විසඳයි. Opening balances සහ cutover timestamp ලියාපදිංචි කරයි.
5. එක් ශාඛාව බැගින් rollout කරයි; release rollback සහ database migration recovery plan තබයි. Payment data මකා “පැරණි version එකට යාම” නොකරයි.
6. Owner වෙත source code/repository, build/setup instructions, data dictionary, architecture decisions, Firebase project ownership/access, backup keys, restore runbook සහ support contacts භාරදෙයි. Credentials public docs තුළ නොතබයි.
7. Cashier manual fallback, printer failure, hub replacement, internet outage සහ lost device සඳහා documented procedures තබයි.

## 22. වියදම් සැලසුම

Exact මුදල් අගයක් branch/device/integration scope නැතිව දිය නොහැක. Budget එකට වෙන වෙනම ඇතුළත් කළ යුතු දේ:

- Development: discovery, UX, frontend, branch service, cloud sync, inventory/production, accounting, QA, data setup සහ training.
- එක් branch එකකට: hub/UPS, network/AP, cashier/tablets, receipt/KOT printers, backup device සහ spare arrangement.
- Recurring: Firebase RTDB usage/bandwidth, cloud compute, object storage/backups, hosting/domain, monitoring සහ support.
- External services: card/payment fees, SMS/email/WhatsApp provider charges සහ delivery integrations අවශ්‍ය නම්.
- Maintenance: OS/browser/security updates, certificates, tested releases, spare hardware සහ periodic restore drills.

Firebase free tier එක මත සම්පූර්ණ production system එක නොමිලේ පවත්වාගත හැකැයි උපකල්පනය නොකරයි. Blaze/billing setup, usage forecasts, budget alerts සහ branch-scoped queries අවශ්‍යය. Exact ගාස්තු implementation අවස්ථාවේ official pricing අනුව ගණනය කරයි. [Firebase pricing](https://firebase.google.com/pricing)

## 23. Development ආරම්භයට අවශ්‍ය තොරතුරු සහ යෝජිත defaults

| අවසන් කළ යුතු තීරණය | මේ සැලැස්මේ default |
|---|---|
| Branch ගණන, users සහ bills/day | Multi-branch architecture; pilot එකට branch 1ක්, test සඳහා අවම branches 2–3ක් |
| Dine-in / takeaway / delivery | තුනම data model තුළ; pilot එකේ actual operations enable කිරීම |
| උපාංග සහ භාෂා | Responsive browser/PWA; Sinhala primary + English/Tamil resources |
| Offline අර්ථය | No-internet full branch LAN operation; isolated devices drafts පමණි |
| Hub hardware | Pilot සඳහා cashier service; වැඩි භාවිතයට dedicated mini-PC + UPS |
| Printing | Hub print bridge; actual Sinhala/Tamil receipt spike |
| Stock model | Prepared batches + made-to-order; moving weighted average costing |
| Offline loyalty/global credit | Redemption disabled; branch quotas අවශ්‍ය නම් පසුව |
| Backup | 15-minute second-device snapshot + shift close + daily cloud backup + restore drill |
| Accounting | Operational finance මුලින්; full double-entry P1 completion, accountant review |
| Payment gateway | මුලින් terminal/reference reconciliation; provider integration වෙනම scope |
| Payroll / online orders | Extension; core branch launch අවහිර නොකරයි |

මේ defaults මත පළමු වැඩ කොටස වන්නේ branch/device/printer survey එක, screen prototype එක සහ **internet කපා තිබියදී phone → local hub → kitchen → cash receipt → reconnect → Firebase reconciliation** යන සම්පූර්ණ technical proof එකයි.
