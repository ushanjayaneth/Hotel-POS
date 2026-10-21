# Register sales, discounts and customer dues

## Counter sales and clearing the register

New register drafts start as **Takeaway**. A normal counter sale does not need a dining table. Select **Dine-in** and a table when serving a seated guest, or **Delivery** for deliveries. An old empty/tableless dine-in draft reopens as Takeaway.

After a payment or credit entry is successfully saved and its receipt opens, the register clears for the next guest. Cancelling the print dialog does not undo the sale. The saved order, receipt and remaining payment balance stay available in Orders and Sales history. A cancelled or failed payment does not clear the saved bill.

## Low stock per product

Use **Products → Add/Edit product → Low stock alert at** to set the threshold for that product. A new product, or a blank threshold, defaults to **5**. Explicit zero is retained and warns when stock reaches zero. Existing linked-stock minimums remain the fallback for older products without their own threshold.

With low-stock alerts enabled, a product at or below its threshold has a thin orange border and remaining-quantity label on the POS menu. Prepared and resale items use current branch stock. Recipe dishes use the number of complete portions that the limiting ingredient can make, including packaging. Untracked products have no stock alert. Holding a bill does not reserve stock; confirmation consumes stock once, using actual quantities and current branch availability.

## Rupee discounts

Owners and managers can apply an **Item discount** from each product line and a **Cart discount** from the register footer. Both are fixed LKR amounts, never percentages. An item discount applies to the whole line, including all units on that line. For example, two LKR 350 items have a LKR 700 line amount; a LKR 50 item discount makes that line LKR 650. A further LKR 20 cart discount gives LKR 630 before applicable service/tax charges.

The backend validates each amount and recalculates prices. A line discount cannot exceed its gross amount; the cart discount cannot exceed the remaining amount after item discounts. Reducing quantity clamps the draft line's discount to its new amount. The receipt separates item and cart discounts. Saved drafts and held bills retain both. Food cost and stock consumption do not decrease merely because a discount is applied.

Persisted orders keep gross `subtotal`, total combined `discount`, explicit `cartDiscount`, and each line's `discount` and net `lineTotal`. This preserves existing net-sales calculations without subtracting item discounts twice. Historical orders without these optional fields remain supported.

## Sell on credit

1. Add products to the register and choose **Sell on credit**.
2. Select an existing customer or create one with name and phone number. You can also use **Add customer** beside the register's customer selector before checkout.
3. Review the customer and credit amount, confirm authorization, then choose **Confirm credit sale**.
4. Open **Customers & dues → Ledger & collect** to see the customer, credited bills and items, outstanding dues, credit refunds, and repayments.
5. Record the amount actually received when the customer repays. Cash collections require an open cash shift. A collection reduces the debt and records the receipt; it does not book the original sale again.

Repayments can be partial. For a LKR 1,000 balance, collecting LKR 300 leaves LKR 700. Each collection retains its own amount, date and payment method. Enter another collection when the customer pays the next instalment; the amount cannot exceed the current balance.

Credit is not cash in the drawer. Part-payment and later collection history are retained. These records use the selected workspace: separate device workspaces do not automatically merge customer balances or stock.
