import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

RowLayout {
    property url iconSource: ""
    property string settingKey: ""
    property string label: ""
    property string value: ""
    property var options: []
    property bool lightTheme: backend.settings.theme === "Светлая"

    Layout.fillWidth: true
    Layout.preferredHeight: 58
    spacing: 10

    SettingIcon { source: iconSource }
    Text { text: label; color: lightTheme ? "#171717" : "#f5f2e9"; font.pixelSize: 13; Layout.fillWidth: true }
    CustomSelect {
        model: options
        currentIndex: Math.max(0, options.indexOf(value))
        onActivated: index => backend.set_setting_value(settingKey, options[index])
    }
}
