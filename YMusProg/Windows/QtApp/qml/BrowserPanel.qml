import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

Rectangle {
    id: root
    property bool lightTheme: backend.settings.theme === "Светлая"

    radius: 10
    color: lightTheme ? "#ffffff" : "#820f0f0f"
    border.color: lightTheme ? "#e2e4ea" : "#22303030"
    border.width: 1

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: root.width < 980 ? 14 : 16
        spacing: 0

        Text { text: "Интеграция с браузерами"; color: root.lightTheme ? "#16140b" : "#f5f2e9"; font.pixelSize: 16; font.bold: true }
        Text { text: "Состояние подключения расширения"; color: root.lightTheme ? "#5b563d" : "#a8a8a8"; font.pixelSize: 12; Layout.topMargin: 5 }

        ListView {
            Layout.fillWidth: true
            Layout.fillHeight: true
            Layout.topMargin: 16
            spacing: 10
            clip: true
            model: backend.browsers

            delegate: Rectangle {
                width: ListView.view.width
                height: 64
                radius: 8
                property int iconX: 12
                property int textX: Math.max(62, Math.min(140, width * 0.18))
                color: root.lightTheme ? "#f7f8fa" : "#70141414"
                border.color: root.lightTheme ? "#e2e4ea" : "#20383838"
                border.width: 1

                Image {
                    id: browserIcon
                    x: parent.iconX
                    anchors.verticalCenter: parent.verticalCenter
                    source: modelData.icon
                    sourceSize.width: 38
                    sourceSize.height: 38
                    width: 38
                    height: 38
                    smooth: true
                    mipmap: true
                    fillMode: Image.PreserveAspectFit
                    opacity: modelData.installed ? 1 : 0.48
                }

                Text {
                    id: browserName
                    x: parent.textX
                    y: 16
                    width: parent.width - parent.textX - 88
                    text: modelData.name
                    color: modelData.installed ? (root.lightTheme ? "#16140b" : "#f5f2e9") : "#777777"
                    font.bold: true
                    font.pixelSize: 13
                    elide: Text.ElideRight
                }

                Row {
                    x: parent.textX
                    y: 36
                    spacing: 6
                    Rectangle { width: 6; height: 6; radius: 3; color: modelData.statusColor; anchors.verticalCenter: parent.verticalCenter }
                    Text { text: modelData.status; color: modelData.statusColor; font.pixelSize: 12 }
                }

                CustomCheckBox {
                    x: parent.width - 48
                    anchors.verticalCenter: parent.verticalCenter
                    visible: modelData.canSelect
                    checked: modelData.selected
                    enabledState: modelData.canSelect
                    onToggled: checked => backend.set_browser_selected(modelData.id, checked)
                }
            }
        }

        GlassButton {
            Layout.fillWidth: true
            text: "Открыть установку"
            textColor: "#ffd400"
            onClicked: backend.install_extension()
        }
    }
}
