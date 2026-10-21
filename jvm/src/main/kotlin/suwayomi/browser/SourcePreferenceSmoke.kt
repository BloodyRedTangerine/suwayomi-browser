package suwayomi.browser

import android.app.Application
import androidx.preference.*
import kotlinx.serialization.json.*

object SourcePreferenceSmoke {
    @JvmStatic fun verify() {
        val context = Application()
        val screen = PreferenceScreen(context).apply { sharedPreferences = context.getSharedPreferences("browser-preference-smoke", 0) }
        val switch = SwitchPreferenceCompat(context).apply { key = "switch" }
        val check = CheckBoxPreference(context).apply { key = "check" }
        val text = EditTextPreference(context).apply { key = "text"; setDefaultValue("default") }
        val list = ListPreference(context).apply { key = "list"; entries = arrayOf("A", "B"); entryValues = arrayOf("a", "b"); setDefaultValue("a") }
        val multi = MultiSelectListPreference(context).apply { key = "multi"; entries = arrayOf("A", "B"); entryValues = arrayOf("a", "b"); setDefaultValue(setOf("a")) }
        listOf(switch, check, text, list, multi).forEach { screen.addPreference(it) }
        fun update(value: String) = SourcePreferences.update(screen, Json.parseToJsonElement(value).jsonObject)
        update("""{"position":0,"switchState":true}""")
        update("""{"position":1,"checkBoxState":true}""")
        update("""{"position":2,"editTextState":"saved"}""")
        update("""{"position":3,"listState":"b"}""")
        update("""{"position":4,"multiSelectState":["a","b"]}""")
        check(switch.currentValue == true && check.currentValue == true && text.currentValue == "saved")
        check(list.currentValue == "b" && multi.currentValue == setOf("a", "b"))
        val described = SourcePreferences.describe(screen)
        check(described.map { it.jsonObject["__typename"]?.jsonPrimitive?.content } == listOf("SwitchPreference", "CheckBoxPreference", "EditTextPreference", "ListPreference", "MultiSelectListPreference"))
        val before = android.content.Context.exportPreferences()
        for (value in listOf(
            """{"position":0,"switchState":"false"}""", """{"position":-1,"editTextState":"bad"}""",
            """{"position":3,"listState":"missing"}""", """{"position":4,"multiSelectState":["missing"]}""",
            """{"position":2,"editTextState":23}""", """{"position":0,"switchState":false,"listState":"a"}""",
        )) check(runCatching { update(value) }.isFailure)
        check(android.content.Context.exportPreferences() == before) { "Invalid preference changed persistent state" }
        var called = false
        list.setOnPreferenceChangeListener { _, _ -> called = true; false }
        check(runCatching { update("""{"position":3,"listState":"a"}""") }.isFailure)
        check(called && list.currentValue == "b") { "Preference veto was ignored" }
        switch.isEnabled = false
        check(runCatching { update("""{"position":0,"switchState":false}""") }.isFailure)
        println("Source preferences: five kinds, typed values, validation, disabled controls and listener veto verified")
    }
}
