; Rust symbols. Captures and properties are described in src/extract/symbols.ts.
; Specific patterns come first: when two patterns find the same item, the earlier one wins.

; Methods in an impl block are named after its type (Point.new); the block's own lines are their group.
(impl_item
  type: [(type_identifier) @scope (generic_type type: (type_identifier) @scope) (scoped_type_identifier name: (type_identifier) @scope)]
  body: (declaration_list (function_item name: (_) @name body: (_) @body) @item)
  (#set! kind "method")) @group
(impl_item
  type: [(type_identifier) @scope (generic_type type: (type_identifier) @scope) (scoped_type_identifier name: (type_identifier) @scope)]
  body: (declaration_list [(const_item name: (_) @name) (type_item name: (_) @name)] @item)
  (#set! kind "const")) @group

; Trait members are methods.
(trait_item body: (declaration_list [(function_item name: (_) @name body: (_) @body) (function_signature_item name: (_) @name)] @item) (#set! kind "method"))

(use_declaration argument: (_) @key (#set! kind "import") (#set! sig "full")) @item
(extern_crate_declaration name: (_) @key (#set! kind "import") (#set! sig "full")) @item

(function_item name: (_) @name body: (_) @body (#set! kind "func")) @item
(function_signature_item name: (_) @name (#set! kind "func")) @item
(macro_definition name: (_) @name (#set! kind "func")) @item

(struct_item name: (_) @name (#set! kind "struct")) @item
(union_item name: (_) @name (#set! kind "struct")) @item
(enum_item name: (_) @name body: (_) @body (#set! kind "enum")) @item
(type_item name: (_) @name (#set! kind "type")) @item
(const_item name: (_) @name (#set! kind "const")) @item
(static_item name: (_) @name (#set! kind "var")) @item

(trait_item name: (_) @name body: (_) @body (#set! kind "interface") (#set! container "true")) @item
(mod_item name: (_) @name body: (_) @body (#set! kind "namespace") (#set! container "true")) @item

