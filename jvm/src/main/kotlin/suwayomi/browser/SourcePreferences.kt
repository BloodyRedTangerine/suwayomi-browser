/* Copyright (C) Contributors to the Suwayomi project. MPL-2.0. */
package suwayomi.browser

import android.app.Application
import androidx.preference.*
import eu.kanade.tachiyomi.source.ConfigurableSource
import eu.kanade.tachiyomi.source.sourcePreferences
import kotlinx.serialization.json.*
import uy.kohesive.injekt.Injekt
import uy.kohesive.injekt.api.get

/** Browser DTOs over upstream AndroidCompat preference objects and listeners. */
object SourcePreferences {
    fun screen(source: ConfigurableSource): PreferenceScreen = PreferenceScreen(Injekt.get<Application>()).apply {
        sharedPreferences = source.sourcePreferences()
        source.setupPreferenceScreen(this)
    }
    private fun text(value: Any?): JsonElement = value?.toString()?.let(::JsonPrimitive) ?: JsonNull
    private fun strings(values: Collection<*>?): JsonElement = values?.let { buildJsonArray { it.forEach { value -> add(value.toString()) } } } ?: JsonNull
    private fun entries(values: Array<out CharSequence>?): JsonArray = buildJsonArray { values?.forEach { add(it.toString()) } }
    fun describe(screen: PreferenceScreen): JsonArray = buildJsonArray {
        screen.preferences.forEach { preference -> add(buildJsonObject {
            put("key", text(preference.key)); put("title", text(preference.title)); put("summary", text(preference.summary))
            put("visible", preference.visible); put("enabled", preference.isEnabled)
            when (preference) {
                is SwitchPreferenceCompat, is CheckBoxPreference -> {
                    put("__typename", if (preference is SwitchPreferenceCompat) "SwitchPreference" else "CheckBoxPreference")
                    put("default", preference.defaultValue as? Boolean ?: false)
                    put("currentValue", preference.currentValue?.let { JsonPrimitive(it as Boolean) } ?: JsonNull)
                }
                is ListPreference -> {
                    put("__typename", "ListPreference"); put("default", text(preference.defaultValue)); put("currentValue", text(preference.currentValue))
                    put("entries", entries(preference.entries)); put("entryValues", entries(preference.entryValues))
                }
                is EditTextPreference -> {
                    put("__typename", "EditTextPreference"); put("default", text(preference.defaultValue)); put("currentValue", text(preference.currentValue))
                    put("dialogTitle", text(preference.dialogTitle)); put("dialogMessage", text(preference.dialogMessage)); put("text", text(preference.text))
                }
                is MultiSelectListPreference -> {
                    put("__typename", "MultiSelectListPreference"); put("default", strings(preference.defaultValue as? Collection<*>))
                    put("currentValue", strings(preference.currentValue as? Collection<*>))
                    put("dialogTitle", text(preference.dialogTitle)); put("dialogMessage", text(preference.dialogMessage))
                    put("entries", entries(preference.entries)); put("entryValues", entries(preference.entryValues))
                }
                else -> error("Unsupported source preference class: ${preference.javaClass.name}")
            }
        }) }
    }

    fun update(screen: PreferenceScreen, change: JsonObject) {
        val p = change["position"] as? JsonPrimitive
        require(p != null && !p.isString) { "Preference position must be an integer" }
        val pref = p.intOrNull?.let { screen.preferences.getOrNull(it) } ?: error("Preference position does not exist")
        require(pref.isEnabled && pref.visible) { "Source preference is disabled or hidden" }
        require(pref.key != null) { "Source preference has no persistent key" }
        val field = when (pref) {
            is SwitchPreferenceCompat -> "switchState"
            is CheckBoxPreference -> "checkBoxState"
            is EditTextPreference -> "editTextState"
            is ListPreference -> "listState"
            is MultiSelectListPreference -> "multiSelectState"
            else -> error("Unsupported source preference class: ${pref.javaClass.name}")
        }
        require(change.keys.all { it == "position" || it == field || change[it] === JsonNull }) { "Wrong state kind for source preference" }
        val element = change[field]
        fun string(value: JsonElement?): String {
            require(value is JsonPrimitive && value.isString) { "Preference state must be a string" }
            return value.content
        }
        val value: Any = when (pref) {
            is SwitchPreferenceCompat, is CheckBoxPreference -> {
                require(element is JsonPrimitive && !element.isString) { "Preference state must be boolean" }
                element.booleanOrNull ?: error("Preference state must be boolean")
            }
            is ListPreference -> string(element).also { selected ->
                require(pref.entryValues?.any { it.toString() == selected } == true) { "Unknown preference list value" }
            }
            is MultiSelectListPreference -> {
                require(element is JsonArray) { "Multi-select state must be an array" }
                element.map { string(it) }.toSet().also { selected ->
                    val allowed = pref.entryValues?.map { it.toString() }?.toSet().orEmpty()
                    require(allowed.containsAll(selected)) { "Unknown multi-select preference value" }
                }
            }
            is EditTextPreference -> string(element)
            else -> error("Unsupported preference")
        }
        // Android's listener veto is meaningful; do not report a rejected value
        // as saved. Source listeners still run as the original extension code.
        require(pref.callChangeListener(value)) { "Source rejected the preference value" }
        pref.saveNewValue(value)
    }
}
