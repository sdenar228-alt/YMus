import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

Button {
    id: root
    property bool lightTheme: backend.settings.theme === "Светлая"
    focusPolicy: Qt.NoFocus
    padding: 0
    font.bold: true
    font.pixelSize: 13

    contentItem: Text {
        text: root.text
        color: "#090909"
        font: root.font
        horizontalAlignment: Text.AlignHCenter
        verticalAlignment: Text.AlignVCenter
    }

    background: Rectangle {
        implicitHeight: 38
        implicitWidth: Math.max(220, root.contentItem.implicitWidth + 44)
        radius: 10
        color: root.down ? "#d4aa00" : (root.hovered ? "#ffe45c" : "#ffd400")
        border.color: "#ffe66a"
        border.width: 1
        Behavior on color { ColorAnimation { duration: 150 } }
    }
}
