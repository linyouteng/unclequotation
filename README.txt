# 修改說明


7. **按檔名前綴篩選**
   - 新增環境變數 `QUOTE_PREFIX`（預設 `q-`）。
   - 列表 API 僅搜尋 `filename` 以該前綴開頭，或 `public_id` 為 `FOLDER/前綴*` 的資源。
   - 例：`q-2024-09-28-...` 才會被列出，避免抓到非報價單的檔案。


8. 列表 API 以 public_id 前綴查詢
   - Search API：`public_id="FOLDER/QUOTE_PREFIX*"` 為主要條件。
   - 若 Search 無法命中，fallback 到 Admin API：`/resources/{rtype}/{dtype}?prefix=FOLDER/QUOTE_PREFIX`。
   - `?noprefix=1` 可暫時停用前綴過濾做排查。
