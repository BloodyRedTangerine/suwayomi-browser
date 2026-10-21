package suwayomi.browser

import eu.kanade.tachiyomi.source.model.Filter
import kotlinx.serialization.json.Json

/** Exercises every source filter kind without substituting extension classes. */
object SourceFilterSmoke {
    @JvmStatic fun verify() {
        val select = object : Filter.Select<String>("Select", arrayOf("A", "B")) {}
        val text = object : Filter.Text("Text") {}
        val checkbox = object : Filter.CheckBox("Check") {}
        val tri = object : Filter.TriState("Tri") {}
        val sort = object : Filter.Sort("Sort", arrayOf("First", "Second")) {}
        val nested = object : Filter.Text("Nested") {}
        val group = object : Filter.Group<Filter<*>>("Group", listOf(object : Filter.Group<Filter<*>>("Inner", listOf(nested)) {})) {}
        val filters = listOf(Filter.Header("Header"), Filter.Separator(), select, text, checkbox, tri, sort, group)
        val before = SourceFilters.describe(filters).toString()
        val changes = Json.parseToJsonElement("""[
          {"position":2,"selectState":1}, {"position":3,"textState":"test"},
          {"position":4,"checkBoxState":true}, {"position":5,"triState":"EXCLUDE"},
          {"position":6,"sortState":{"index":1,"ascending":false}},
          {"position":7,"groupChange":{"position":0,"groupChange":{"position":0,"textState":"deep"}}}
        ]""")
        val restore = SourceFilters.apply(filters, changes)
        check(select.state == 1 && text.state == "test" && checkbox.state && tri.state == 2)
        check(sort.state == Filter.Sort.Selection(1, false) && nested.state == "deep")
        restore.close()
        check(SourceFilters.describe(filters).toString() == before) { "Filter state did not reset" }
        for (invalid in listOf(
            """[{"position":3,"textState":"must not be applied"},{"position":2,"selectState":9}]""",
            """[{"position":-1,"textState":"bad"}]""",
            """[{"position":4,"checkBoxState":"false"}]""",
            """[{"position":5,"triState":"UNKNOWN"}]""",
            """[{"position":6,"sortState":{"index":-1,"ascending":true}}]""",
            """[{"position":3,"textState":42}]""",
            """[{"position":2,"selectState":1,"textState":"wrong kind"}]""",
        )) {
            check(runCatching { SourceFilters.apply(filters, Json.parseToJsonElement(invalid)) }.isFailure) { "Invalid filter accepted: $invalid" }
            check(SourceFilters.describe(filters).toString() == before) { "Invalid change partially mutated filters" }
        }
        println("Source filters: all kinds, nested groups, validation and reset verified")
    }
}
