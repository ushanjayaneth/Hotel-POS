# Owner quick start

Keep the completed [customer handover record](CUSTOMER-HANDOVER.md), the trusted app address, and your support contact with this guide. Use the operating mode agreed at handover.

## Open and sign in

- **Device workspace:** open the same app URL in the same browser/profile used for setup, or its installed PWA. On a new empty device, choose **Set up this device** on the sign-in screen, enter the business/owner details, and create a private **6-12 digit Owner PIN**. Leave sample data off for a new live business. There is no fixed default owner PIN for a new device workspace.
- **Existing workspace:** sign in with your private PIN. There is no separate admin URL; the Owner role has management access. If existing records suddenly appear missing, stop and check the URL/browser/profile before creating a new workspace.
- **Shared branch hub:** use the branch's agreed HTTPS address and staff PIN. The hub and local network must be running. A device workspace on another phone is a separate database, even if it uses the same public website.

First setup and app caching need an online connection. After caching, test offline use before relying on it. Settings offers **Install app** where supported; the browser may also provide an install/add-to-home-screen menu. Installation does not create an independent backup.

## Before opening the till

1. Check the correct branch/workspace and today's opening stock. Review low-stock items and any unfinished bills.
2. Open a cash shift and enter the actual opening cash before accepting cash payments or cash debt collections.
3. Check paper and print a test receipt after changing the printer. Adjust receipt paper/content width and margins in Settings; test the actual result.
4. Use the assigned staff PIN rather than sharing owner access.

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

For prepared food, record ingredients and packaging in their correct inventory units. In the recipe editor, enter the whole batch quantities and **Recipe yield (portions)**. LKR 10,000 of ingredients for 50 portions means LKR 200 food cost per portion; a LKR 350 selling price gives LKR 150 gross profit before other deductions. Reports use saved sale costs where available and identify estimates. Profit and cash received can differ, especially for credit bills.

## Close the day and protect the records

1. Review sales, refunds, outstanding dues, expenses, and held bills. Record actual operating expenses.
2. Count cash and complete the shift/day-end reconciliation. Download the required reports and investigate differences.
3. **Device mode:** as Owner, open **Settings -> Device storage & backups**, export an encrypted `.hotelbackup` file using a strong password of at least ten characters, and copy it to the agreed independent storage. Keep several dated copies and the password separately.
4. **Hub mode:** follow the agreed full database backup procedure in the [operations runbook](OPERATIONS.md). A frontend download or cached snapshot is not a full hub backup.

Do not clear site data, use private browsing for live records, delete the operating browser profile, or change the app address without a recovery plan. The browser controls storage capacity; keep free space and independent backups even after installing the app. A backup download message does not verify that the file was copied safely.

Periodically test a device backup through **Restore device backup** in an empty spare browser profile. Review the preview, restore, sign in with a PIN saved in that backup, and compare stock, sales, customer dues, and photos. Restore replaces records; do not restore over the live till for a test, or use the restored copy as a simultaneous second cashier for the same stock. A forgotten backup password cannot be recovered by the app.

## If something goes wrong

- For a printer problem, check the saved sale in history and reprint after fixing the printer. Avoid a duplicate sale.
- For an internet outage, a cached device workspace can keep working. A shared-hub installation can keep working while its hub and LAN remain available; a hub-disconnected device can retain drafts but cannot confirm hub transactions.
- For a storage/save error, stop repeated checkout attempts, keep any unsaved details, check the saved history, free space or contact support, and retry only after confirming the previous result. Do not clear site data to fix storage.
- For lost records or a damaged device, preserve the device and latest backup; contact the named support person before replacing or resetting data.

Support contact / hours: ______________________________

Backup operator / storage location: ______________________________

Read [sales and customer dues](POS-SALES.md) for transaction details and the [device workspace guide](DEVICE-WORKSPACE.md) for storage, photos, backup/restore, and operating limits. Separate devices do not automatically synchronize their sales, stock, or dues with Firebase.
