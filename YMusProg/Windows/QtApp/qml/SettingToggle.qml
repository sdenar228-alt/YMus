import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

RowLayout {
    property url iconSource: ""
    property string settingKey: ""
    property string label: ""
    property bool checked: false
    property bool lightTheme: backend.settings.theme === "Светлая"

    Layout.fillWidth: true
    Layout.preferredHeight: 58
    spacing: 10

    SettingIcon { source: iconSource }
    Text { text: label; color: lightTheme ? "#171717" : "#f5f2e9"; font.pixelSize: 13; Layout.fillWidth: true }
    Switch {
        id: control
        focusPolicy: Qt.NoFocus
        checked: parent.checked
        onToggled: backend.set_setting_bool(settingKey, checked)
        indicator: Rectangle {
            implicitWidth: 40
            implicitHeight: 21
            radius: 11
            color: control.checked ? "#ffd400" : (lightTheme ? "#dfe2e8" : "#202020")
            border.color: control.checked ? "#ffd400" : (lightTheme ? "#c2c5cd" : "#777777")
            Rectangle {
                x: control.checked ? parent.width - width - 3 : 3
                anchors.verticalCenter: parent.verticalCenter
                width: 15
                height: 15
                radius: 8
                color: "#ffffff"
                Behavior on x { NumberAnimation { duration: 120 } }
            }
        }
    }
}
