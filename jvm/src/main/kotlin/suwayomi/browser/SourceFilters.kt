/* Copyright (C) Contributors to the Suwayomi project. MPL-2.0. */
package suwayomi.browser

import eu.kanade.tachiyomi.source.model.Filter
import kotlinx.serialization.json.*

/** GraphQL filter DTOs over the extension's actual subclasses, not replacements.
 * Keep subclass identity: extension request builders inspect their own classes.
 */
object SourceFilters {
    fun describe(filters: List<Filter<*>>): JsonArray = buildJsonArray {
        filters.forEach { add(describe(it, 0)) }
    }

    private fun children(filter: Filter.Group<*>): List<Filter<*>> = filter.state.map {
        require(it is Filter<*>) { "Source filter group contains a non-filter value" }
        it
    }

    private fun describe(filter: Filter<*>, depth: Int): JsonObject = buildJsonObject {
        require(depth <= 32) { "Source filter nesting exceeds 32 levels" }
        put("name", filter.name)
        when (filter) {
            is Filter.Header -> put("__typename", "HeaderFilter")
            is Filter.Separator -> put("__typename", "SeparatorFilter")
            is Filter.Text -> { put("__typename", "TextFilter"); put("default", filter.state) }
            is Filter.CheckBox -> { put("__typename", "CheckBoxFilter"); put("default", filter.state) }
            is Filter.TriState -> {
                put("__typename", "TriStateFilter")
                put("default", listOf("IGNORE", "INCLUDE", "EXCLUDE").getOrNull(filter.state)
                    ?: error("Invalid source tri-state default"))
            }
            is Filter.Select<*> -> {
                put("__typename", "SelectFilter"); put("default", filter.state)
                put("values", buildJsonArray { filter.displayValues.forEach { add(it) } })
            }
            is Filter.Sort -> {
                put("__typename", "SortFilter")
                put("values", buildJsonArray { filter.values.forEach { add(it) } })
                put("default", filter.state?.let { state -> buildJsonObject {
                    put("__typename", "SortSelection"); put("index", state.index); put("ascending", state.ascending)
                } } ?: JsonNull)
            }
            is Filter.Group<*> -> {
                put("__typename", "GroupFilter")
                put("filters", buildJsonArray { children(filter).forEach { add(describe(it, depth + 1)) } })
            }
            else -> error("Unsupported source filter class: ${filter.javaClass.name}")
        }
    }

    /** Validate the complete change set before mutating anything. Restore source
     * defaults after the request, including when an extension caches filter lists.
     */
    fun apply(filters: List<Filter<*>>, changes: JsonElement?): AutoCloseable {
        val mutations = mutableListOf<() -> Unit>()
        val undo = mutableListOf<() -> Unit>()
        fun <T> set(filter: Filter<T>, value: T) {
            mutations.add {
                val previous = filter.state
                undo.add { filter.state = previous }
                filter.state = value
            }
        }
        fun primitive(value: JsonElement?, name: String): JsonPrimitive =
            (value as? JsonPrimitive)?.takeUnless { it === JsonNull }
                ?: throw IllegalArgumentException("Expected $name filter state")
        fun integer(value: JsonElement?, name: String): Int {
            val p = primitive(value, name)
            require(!p.isString) { "$name must be an integer" }
            return p.intOrNull ?: throw IllegalArgumentException("$name must be an integer")
        }
        fun bool(value: JsonElement?, name: String): Boolean {
            val p = primitive(value, name)
            require(!p.isString) { "$name must be boolean" }
            return p.booleanOrNull ?: throw IllegalArgumentException("$name must be boolean")
        }
        var count = 0
        fun change(list: List<Filter<*>>, value: JsonElement, depth: Int) {
            require(depth <= 32 && ++count <= 10000) { "Source filter change set is too large" }
            val input = value as? JsonObject ?: throw IllegalArgumentException("Filter change must be an object")
            val position = integer(input["position"], "position")
            val filter = list.getOrNull(position) ?: throw IllegalArgumentException("Filter position $position does not exist")
            val field = when (filter) {
                is Filter.Select<*> -> "selectState"
                is Filter.Text -> "textState"
                is Filter.CheckBox -> "checkBoxState"
                is Filter.TriState -> "triState"
                is Filter.Sort -> "sortState"
                is Filter.Group<*> -> "groupChange"
                else -> throw IllegalArgumentException("Filter ${filter.name} is not editable")
            }
            require(input.keys.all { it == "position" || it == field || input[it] === JsonNull }) { "Unexpected state field for ${filter.name}" }
            when (filter) {
                is Filter.Select<*> -> {
                    val index = integer(input[field], field)
                    require(index in filter.values.indices) { "Select filter index is out of range" }
                    set(filter, index)
                }
                is Filter.Text -> {
                    val state = primitive(input[field], field)
                    require(state.isString) { "Text filter state must be a string" }
                    set(filter, state.content)
                }
                is Filter.CheckBox -> set(filter, bool(input[field], field))
                is Filter.TriState -> {
                    val state = primitive(input[field], field)
                    require(state.isString) { "Tri-state must be an enum string" }
                    val index = listOf("IGNORE", "INCLUDE", "EXCLUDE").indexOf(state.content)
                    require(index >= 0) { "Invalid tri-state filter value" }
                    set(filter, index)
                }
                is Filter.Sort -> {
                    val state = input[field] as? JsonObject ?: throw IllegalArgumentException("Expected sort selection")
                    require(state.keys.all { it == "index" || it == "ascending" }) { "Unexpected sort selection field" }
                    val index = integer(state["index"], "sort index")
                    require(index in filter.values.indices) { "Sort filter index is out of range" }
                    set(filter, Filter.Sort.Selection(index, bool(state["ascending"], "ascending")))
                }
                is Filter.Group<*> -> change(children(filter), input[field] ?: error("Missing group change"), depth + 1)
            }
        }
        if (changes != null && changes !== JsonNull) {
            require(changes is JsonArray) { "Filter changes must be an array" }
            changes.forEach { change(filters, it, 0) }
        }
        mutations.forEach { it() }
        return AutoCloseable { undo.asReversed().forEach { it() } }
    }
}
