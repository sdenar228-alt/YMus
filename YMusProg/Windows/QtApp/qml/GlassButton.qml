import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

Button {
    id: root
    property bool lightTheme: backend.settings.theme === "Светлая"
    property color textColor: lightTheme ? "#16140b" : "#f5f2e9"
    property int preferredWidth: implicitWidth
    // Жёлтый акцентный текст на светлой кнопке нечитаем — заменяем на тёмное золото.
    property color effectiveText: (lightTheme && textColor == "#ffd400") ? "#8a6d00" : textColor

    Layout.preferredWidth: preferredWidth
    focusPolicy: Qt.NoFocus
    padding: 0
    font.bold: true
    font.pixelSize: 13

    contentItem: Text {
        text: root.text
        color: root.effectiveText
        font: root.font
        horizontalAlignment: Text.AlignHCenter
        verticalAlignment: Text.AlignVCenter
    }

    background: Rectangle {
        implicitHeight: 36
        implicitWidth: Math.max(36, root.contentItem.implicitWidth + 28)
        radius: 10
        color: root.lightTheme
            ? (root.down ? "#e6e8ee" : (root.hovered ? "#eef0f4" : "#f4f5f8"))
            : (root.down ? "#2b260d" : (root.hovered ? "#211d0b" : "#76121212"))
        border.color: root.hovered ? (root.lightTheme ? "#caa400" : "#aa9400") : (root.lightTheme ? "#d3d6de" : "#303a3a3a")
        border.width: 1
        Behavior on color { ColorAnimation { duration: 140 } }
        Behavior on border.color { ColorAnimation { duration: 140 } }
    }
}
