# Owner quick start

Keep the completed [customer handover record](CUSTOMER-HANDOVER.md), the trusted app address, and your support contact with this guide. Use the operating mode agreed at handover.

## Open and sign in

- **Device workspace:** open the same app URL in the same browser/profile used for setup, or its installed PWA. On a new empty device, choose **Set up this device** on the sign-in screen, enter the business/owner details, and create a private **6-12 digit Owner PIN**. Leave sample data off for a new live business. There is no fixed default owner PIN for a new device workspace.
- **Existing workspace:** sign in with your private PIN. There is no separate admin URL; the Owner role has management access. If existing records suddenly appear missing, stop and check the URL/browser/profile before creating a new workspace.
- **Shared branch hub:** use the branch's agreed HTTPS address and staff PIN. The hub and local network must be running. A device workspace on another phone is a separate database, even if it uses the same public website.
- **Shared cloud POS:** open the normal app address and enter the shop's same private **Staff PIN** once online on each device/browser profile. The shop opens automatically without a separate cloud account, picker or connection form. That same PIN then works offline, including after logout or reload. Its prepared offline cache can save bills, payments, customer loans/collections, products, stock and expenses and show reports without internet. Reconnect with the app open to upload pending updates and share them with the other devices. The shared owner PIN does not migrate separate local staff PIN accounts.

First setup, a device's first verified PIN entry and app caching need an online connection. Afterwards, the website works directly in the same browser; downloading/installing an app is optional. Logging out keeps the prepared offline PIN, saved records and unsynced bills. Test offline logout, sign-in and billing before relying on the device. Settings offers **Install app** where supported; the browser may also provide an install/add-to-home-screen menu. Installation does not create an independent backup or prevent site-data clearing. The app requests persistent storage once where supported, remembers refusals and offers a manual retry in Settings. The permission protects against automatic eviction, not deliberate deletion, formatting or device loss.

## Before opening the till

1. Check the correct branch/workspace and today's opening stock. Review low-stock items and any unfinished bills.
2. Open a cash shift and enter the actual opening cash before accepting cash payments or cash debt collections.
3. Check paper and print a test receipt after changing the printer. Adjust receipt paper/content width and margins in Settings; test the actual result.
4. In local/hub mode, use the assigned staff PIN. In shared cloud mode, keep the shop's private POS PIN restricted to its authorized owner/devices. Independent staff PIN/role migration is not part of this feature.

## Make a sale

1. Open **Point of sale**, search/scan products, and add the required quantities.
2. Counter sales start as **Takeaway**. Tables are optional even with **Dine-in**: leave **No table (optional)** selected to sell without one, or select a table to track a seated guest. The configured dine-in service charge still applies.
3. Owners/managers can enter fixed rupee **Item discount** amounts on a line and a **Cart discount** for the whole bill. An item discount covers the entire line, not each unit separately.
4. Review the total, take payment, and confirm. Card/QR entries record payments checked separately on your bank/terminal; they do not charge or verify payments automatically.
5. When the saved receipt opens, the register clears for the next customer. Cancelling the print dialog does not cancel the sale. Find the saved bill in **Sales history** to reprint; do not repeat checkout just to get a receipt.

Use **Hold bill** to return to an unfinished basket. A held bill does not reserve stock. If a save fails, read the error and check the saved order/history before retrying. Do not assume that a failed print means a failed payment.

## Customer Loan and instalments

1. Add the items and choose **Customer Loan**. Choose **Existing customer** to reuse a saved account, or **New customer** to enter a name and phone number. Email is optional. Check the details and outstanding balance, then choose **Continue to loan**.
2. Review the account and amount in **Take payment**, tick the authorization confirmation, then choose **Confirm customer loan**. Before any payments or refunds have been recorded, **Change customer** lets you correct the account.
3. You can also choose **Charge order → Customer Loan** and add/select the customer directly there; selecting a customer before checkout is optional. Cancelling the chooser creates no debt. An order already submitted remains in **Orders** if payment is cancelled.
4. In **Customers & dues**, open **Ledger & collect** to review the credited bills/items and balance. Select the same saved customer on their next loan.
5. When money is received, enter the amount actually paid and the payment method. Cash collections need an open cash shift.

Customers may pay in parts: collecting LKR 300 against LKR 1,000 leaves LKR 700. Record the next instalment when received. Each collection keeps its own history; never enter the original sale again to record a repayment.

## Products, stock, and profit

Use **Products** for categories, prices, costs, barcodes, and **Low stock alert at**. A blank new-product threshold defaults to **5**. At or below the threshold, tracked products have a thin orange POS border. Recipe products use the portions available from their ingredients. Record real purchases, production, and stock adjustments instead of changing quantities to hide a discrepancy.

For a product photo, use **Take photo** to open the camera, **Choose photo** to select a JPEG/PNG/WebP file, or paste an HTTPS image link. Camera/file images are optimized for clear product photos and saved as files no larger than 450 KB. They can be added offline and upload automatically when the app reconnects. Other devices download shared photos when needed and keep them for later offline use. An external image link still depends on that website and the network.

For prepared food, record ingredients and packaging in their correct inventory units. In the recipe editor, enter the whole batch quantities and **Recipe yield (portions)**. LKR 10,000 of ingredients for 50 portions means LKR 200 food cost per portion; a LKR 350 selling price gives LKR 150 gross profit before other deductions. Reports use saved sale costs where available and identify estimates. Profit and cash received can differ, especially for credit bills.

## Close the day and protect the records

1. Review sales, refunds, outstanding dues, expenses, and held bills. Record actual operating expenses.
2. Count cash and complete the shift/day-end reconciliation. Download the required reports and investigate differences.
3. **Device mode:** as Owner, open **Settings -> Device storage & backups**, export an encrypted `.hotelbackup` file using a strong password of at least ten characters, and copy it to the agreed independent storage. Keep several dated copies and the password separately.
4. **Hub mode:** follow the agreed full database backup procedure in the [operations runbook](OPERATIONS.md). A frontend download or cached snapshot is not a full hub backup.
5. **Cloud mode:** verify the actual cloud acknowledgement and recent sale on a separate device. Keep an independent cloud recovery plan and the original local backup. The local `.hotelbackup` does not include later transactions made only in the shared cloud workspace.

Do not clear site data, use private browsing for live records, delete the operating browser profile, or change the app address without a recovery plan. The browser controls storage capacity; keep free space and independent backups even after installing the app. A backup download message does not verify that the file was copied safely.

Periodically test a device backup through **Restore device backup** in an empty spare browser profile. Review the preview, restore, sign in with a PIN saved in that backup, and compare stock, sales, customer dues, and photos. Restore replaces records; do not restore over the live till for a test, or use the restored copy as a simultaneous second cashier for the same stock. A forgotten backup password cannot be recovered by the app.

## If something goes wrong

- For a printer problem, check the saved sale in history and reprint after fixing the printer. Avoid a duplicate sale.
- For an internet outage, a cached device workspace can keep working. A shared-hub installation can keep working while its hub and LAN remain available; a hub-disconnected device can retain drafts but cannot confirm hub transactions.
- In shared cloud mode, sign in with the same Staff PIN and continue billing and printing from the prepared offline cache. If you logged out, the verified offline PIN still works; a first visit or cleared browser must connect and verify it online once. Bills and payments save on this device first. Keep the app open after reconnecting until the pending counter clears; verify a recent bill and balance on another device. Do not clear site data while uploads are pending. Two disconnected tills cannot see each other's stock; review any shortage or edit-conflict warning after sync.
- For a storage/save error, stop repeated checkout attempts, keep any unsaved details, check the saved history, free space or contact support, and retry only after confirming the previous result. Do not clear site data to fix storage.
- For lost records or a damaged device, preserve the device and latest backup; contact the named support person before replacing or resetting data.

For cloud records after browser clearing or device loss, open the normal app address while online and enter the same private POS PIN. The shop and its acknowledged records load automatically; no cloud account or workspace selection is needed. Shared photos download as needed. Clearing site data removes the remembered login, offline PIN credential, cache and pending uploads; online PIN verification prepares the device again. Check the latest sale, stock and loan balance before using the till again. Unuploaded offline changes/photos, independent local staff credentials and unfinished device drafts cannot be recovered by reopening shared POS. A verified local `.hotelbackup` is needed for the omitted parts of the original local workspace.

Support contact / hours: ______________________________

Backup operator / storage location: ______________________________

Read [sales and customer dues](POS-SALES.md), the [device workspace guide](DEVICE-WORKSPACE.md) and the [cloud setup and recovery guide](CLOUD-SYNC.md). For the initial cloud transfer, open the original shop device first and keep it online until its existing records finish uploading. Independent local copies do not merge automatically into the shared shop. Only acknowledged cloud records can be recovered from the cloud; installing the app alone does not provide that guarantee.
