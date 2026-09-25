; Java symbols. Captures and properties are described in src/extract/symbols.ts.

(import_declaration (_) @key (#set! kind "import") (#set! sig "full")) @item

(class_declaration name: (_) @name body: (_) @body (#set! kind "class") (#set! container "true")) @item
(interface_declaration name: (_) @name body: (_) @body (#set! kind "interface") (#set! container "true")) @item
(enum_declaration name: (_) @name body: (_) @body (#set! kind "enum") (#set! container "true")) @item
(record_declaration name: (_) @name body: (_) @body (#set! kind "class") (#set! container "true")) @item
(annotation_type_declaration name: (_) @name body: (_) @body (#set! kind "interface")) @item

(method_declaration name: (_) @name body: (_)? @body (#set! kind "method")) @item
(constructor_declaration name: (_) @name body: (_) @body (#set! kind "method")) @item
(field_declaration declarator: (variable_declarator name: (_) @name) (#set! kind "field")) @item
(constant_declaration declarator: (variable_declarator name: (_) @name) (#set! kind "field")) @item
