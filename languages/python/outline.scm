; Python symbols. Captures and properties are described in src/extract/symbols.ts.

(module [(import_statement) (import_from_statement)] @item @key
  (#set! kind "import") (#set! sig "full"))

(class_definition name: (_) @name body: (_) @body
  (#set! kind "class") (#set! container "true")) @item

(function_definition name: (_) @name body: (_) @body
  (#set! kind "function") (#set! kind.member "method")) @item

(module (expression_statement (assignment left: (_) @name)) @item
  (#set! kind "var"))
