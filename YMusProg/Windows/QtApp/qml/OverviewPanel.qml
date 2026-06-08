import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

Rectangle {
    id: root
    property bool lightTheme: backend.settings.theme === "Светлая"

    radius: 12
    color: lightTheme ? "#ffffff" : "#860f0f0f"
    border.color: lightTheme ? "#e2e4ea" : "#22303030"
    border.width: 1

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: root.width < 980 ? 16 : 22
        spacing: root.height < 640 ? 12 : 18

        RowLayout {
            Layout.fillWidth: true
            spacing: 16

            ColumnLayout {
                Layout.fillWidth: true
                spacing: 8
                Text {
                    text: "Установка расширения"
                    color: root.lightTheme ? "#16140b" : "#f5f2e9"
                    font.pixelSize: 28
                    font.bold: true
                }
                Text {
                    text: "YMus подготовит распакованную папку, скопирует путь и откроет страницу расширений в выбранных браузерах."
                    color: root.lightTheme ? "#5b563d" : "#a8a8a8"
                    font.pixelSize: 13
                    wrapMode: Text.WordWrap
                    Layout.maximumWidth: 680
                }
            }

            Item { Layout.preferredWidth: 1 }
        }

        // Плашка-подсказка про разрешение «Универсальный доступ» (macOS).
        // На Windows показывается для предпросмотра (backend.accessibilityNeeded).
        Rectangle {
            visible: backend.accessibilityNeeded
            Layout.fillWidth: true
            Layout.preferredHeight: 70
            radius: 12
            color: root.lightTheme ? "#fff8e0" : "#171204"
            border.color: "#88ffd400"
            border.width: 1

            RowLayout {
                anchors.fill: parent
                anchors.leftMargin: 16
                anchors.rightMargin: 12
                spacing: 14

                Rectangle {
                    Layout.preferredWidth: 38
                    Layout.preferredHeight: 38
                    radius: 11
                    color: "#33ffd400"
                    Text {
                        anchors.centerIn: parent
                        text: "!"
                        color: "#ffd400"
                        font.pixelSize: 22
                        font.bold: true
                    }
                }

                ColumnLayout {
                    Layout.fillWidth: true
                    spacing: 2
                    Text {
                        text: "Нужно разрешение «Универсальный доступ»"
                        color: root.lightTheme ? "#16140b" : "#f5f2e9"
                        font.pixelSize: 14
                        font.bold: true
                        elide: Text.ElideRight
                        Layout.fillWidth: true
                    }
                    Text {
                        text: "Чтобы YMus сам устанавливал расширение, включите его в настройках доступа."
                        color: root.lightTheme ? "#5b563d" : "#a8a8a8"
                        font.pixelSize: 12
                        elide: Text.ElideRight
                        Layout.fillWidth: true
                    }
                }

                PrimaryButton {
                    text: "Открыть настройки"
                    onClicked: backend.open_accessibility_settings()
                }
            }
        }

        Rectangle {
            visible: backend.extUpdateAvailable
            Layout.fillWidth: true
            Layout.preferredHeight: 60
            radius: 12
            color: root.lightTheme ? "#fff8e0" : "#171204"
            border.color: "#88ffd400"
            border.width: 1

            RowLayout {
                anchors.fill: parent
                anchors.leftMargin: 16
                anchors.rightMargin: 12
                spacing: 12
                Text {
                    Layout.fillWidth: true
                    text: "Доступно обновление расширения " + backend.extLatestVersion
                    color: root.lightTheme ? "#16140b" : "#f5f2e9"
                    font.pixelSize: 14
                    font.bold: true
                    elide: Text.ElideRight
                }
                PrimaryButton {
                    text: backend.busy ? "Обновляем..." : "Обновить расширение"
                    enabled: !backend.busy
                    onClicked: backend.update_extension()
                }
            }
        }

        Rectangle {
            Layout.fillWidth: true
            Layout.preferredHeight: 88
            radius: 12
            color: root.lightTheme ? "#f4f5f8" : "#8c121212"
            border.color: root.lightTheme ? "#e2e4ea" : "#24383838"

            RowLayout {
                anchors.fill: parent
                anchors.margins: 16
                spacing: 14

                Rectangle {
                    Layout.preferredWidth: 54
                    Layout.preferredHeight: 54
                    radius: 14
                    color: "#ffd400"
                    Image {
                        anchors.centerIn: parent
                        width: 34
                        height: 34
                        source: assetsDir + "/app/Icon128x128.png"
                        smooth: true
                        mipmap: true
                        fillMode: Image.PreserveAspectFit
                    }
                }

                ColumnLayout {
                    Layout.fillWidth: true
                    spacing: 4
                    Text { text: "Папка расширения"; color: root.lightTheme ? "#16140b" : "#f5f2e9"; font.pixelSize: 15; font.bold: true }
                    Text {
                        text: backend.preparedPath
                        color: root.lightTheme ? "#5b563d" : "#a8a8a8"
                        font.pixelSize: 12
                        elide: Text.ElideMiddle
                        Layout.fillWidth: true
                    }
                }

                GlassButton {
                    text: "Открыть папку"
                    preferredWidth: 138
                    onClicked: backend.open_prepared_folder()
                }
            }
        }

        RowLayout {
            Layout.fillWidth: true
            Layout.fillHeight: true
            spacing: 18

            Rectangle {
                Layout.fillWidth: true
                Layout.fillHeight: true
                radius: 12
                color: root.lightTheme ? "#f7f8fa" : "#8a101010"
                border.color: root.lightTheme ? "#e2e4ea" : "#24383838"

                ColumnLayout {
                    anchors.fill: parent
                    anchors.margins: 16
                    spacing: 12

                    RowLayout {
                        Layout.fillWidth: true
                        Text { text: "Браузеры"; color: root.lightTheme ? "#16140b" : "#f5f2e9"; font.pixelSize: 18; font.bold: true }
                        Item { Layout.fillWidth: true }
                        Text { text: backend.connectedCount + " активно"; color: "#ffd400"; font.pixelSize: 12; font.bold: true }
                    }

                    ListView {
                        Layout.fillWidth: true
                        Layout.fillHeight: true
                        clip: true
                        spacing: 8
                        model: backend.browsers

                        delegate: Rectangle {
                            width: ListView.view.width
                            height: 64
                            radius: 9
                            property int iconX: Math.max(82, Math.min(150, width * 0.13))
                            property int textX: Math.max(iconX + 78, Math.min(370, width * 0.32))
                            color: modelData.selected && modelData.canSelect ? (root.lightTheme ? "#fff4c6" : "#8d191707") : (root.lightTheme ? "#ffffff" : "#78121212")
                            border.color: modelData.selected && modelData.canSelect ? "#88ffd400" : "#24383838"
                            border.width: 1

                            MouseArea {
                                anchors.fill: parent
                                enabled: modelData.canSelect
                                cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
                                onClicked: backend.set_browser_selected(modelData.id, !modelData.selected)
                            }

                            CustomCheckBox {
                                x: 12
                                anchors.verticalCenter: parent.verticalCenter
                                enabledState: modelData.canSelect
                                checked: modelData.selected
                                onToggled: checked => backend.set_browser_selected(modelData.id, checked)
                            }

                            Image {
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
                                opacity: modelData.installed ? 1 : 0.45
                            }

                            Column {
                                x: parent.textX
                                anchors.verticalCenter: parent.verticalCenter
                                width: Math.max(160, parent.width - parent.textX - 210)
                                spacing: 2
                                Text {
                                    text: modelData.name
                                    color: modelData.installed ? (root.lightTheme ? "#16140b" : "#f5f2e9") : "#777777"
                                    font.pixelSize: 14
                                    font.bold: true
                                    elide: Text.ElideRight
                                    width: parent.width
                                }
                                Text {
                                    text: modelData.installed ? modelData.extensionsUrl : "Браузер не найден"
                                    color: root.lightTheme ? "#5b563d" : "#a8a8a8"
                                    font.pixelSize: 12
                                    elide: Text.ElideRight
                                    width: parent.width
                                }
                            }

                            Text {
                                anchors.right: parent.right
                                anchors.rightMargin: 120
                                anchors.verticalCenter: parent.verticalCenter
                                text: modelData.canSelect ? "готов" : "нет"
                                color: modelData.canSelect ? "#ffd400" : "#777777"
                                font.pixelSize: 12
                                font.bold: true
                            }
                        }
                    }
                }
            }

            Rectangle {
                Layout.preferredWidth: Math.max(286, Math.min(330, root.width * 0.27))
                Layout.fillHeight: true
                radius: 12
                color: root.lightTheme ? "#fff8e0" : "#90151204"
                border.color: "#88ffd400"
                border.width: 1
                clip: true

                ScrollView {
                    id: instructionScroll
                    anchors.fill: parent
                    anchors.margins: root.width < 980 ? 14 : 18
                    clip: true
                    contentWidth: availableWidth

                    ColumnLayout {
                        width: instructionScroll.availableWidth
                        spacing: 14

                        Text { text: "Один понятный шаг"; color: root.lightTheme ? "#16140b" : "#f5f2e9"; font.pixelSize: 22; font.bold: true; Layout.fillWidth: true; wrapMode: Text.WordWrap }
                        Text {
                            text: "После нажатия кнопки останется включить режим разработчика и выбрать «Загрузить распакованное». Путь уже будет в буфере обмена."
                            color: root.lightTheme ? "#4e482b" : "#c9c2a8"
                            font.pixelSize: 12
                            wrapMode: Text.WordWrap
                            Layout.fillWidth: true
                        }

                        Repeater {
                            model: ["Нажмите кнопку ниже", "Включите режим разработчика", "Выберите «Загрузить распакованное»", "Вставьте путь из буфера обмена"]
                            delegate: RowLayout {
                                Layout.fillWidth: true
                                spacing: 10
                                Rectangle {
                                    Layout.preferredWidth: 24
                                    Layout.preferredHeight: 24
                                    radius: 12
                                    color: root.lightTheme ? "#1f1f24" : "#332a00"
                                    Text {
                                        anchors.centerIn: parent
                                        text: index + 1
                                        color: "#ffd400"
                                        font.bold: true
                                        font.pixelSize: 12
                                    }
                                }
                                Text {
                                    text: modelData
                                    color: root.lightTheme ? "#16140b" : "#f5f2e9"
                                    font.pixelSize: 13
                                    font.bold: true
                                    Layout.fillWidth: true
                                    wrapMode: Text.WordWrap
                                }
                            }
                        }

                        PrimaryButton {
                            Layout.fillWidth: true
                            text: backend.busy ? "Готовим..." : "Подготовить и открыть браузеры"
                            enabled: !backend.busy && backend.connectedCount > 0
                            onClicked: backend.install_extension()
                        }

                        Item { Layout.preferredHeight: 2 }
                    }
                }
            }
        }
    }
}
