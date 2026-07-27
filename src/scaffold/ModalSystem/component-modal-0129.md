# Modal Component

**Status**: ✅ Complete  
**Location**: `src/scaffold/ModalSystem/`  
**Last Updated**: January 29, 2026

---

## Overview

The Modal component provides a fully custom modal implementation with solid backgrounds. It's the **unified modal system** for the entire application, consolidating both declarative and imperative modal patterns. Features portal rendering, focus trap, keyboard navigation, body scroll lock, multi-modal support, and static methods for imperative usage.

### Key Features

- ✅ **Solid Background**: Clean solid background design (no glassmorphism)
- ✅ **Portal Rendering**: Portal rendering for proper z-index management
- ✅ **Multi-Modal Support**: Show multiple modals simultaneously
- ✅ **Imperative API**: `Modal.open()`, `Modal.close()`, `Modal.closeAll()`
- ✅ **Click Outside**: Click outside to close (maskClosable)
- ✅ **ESC Key**: ESC key to close (escToExit)
- ✅ **Focus Trap**: Focus trap for accessibility (always enabled)
- ✅ **Body Scroll Lock**: Prevents body scrolling when modal is open
- ✅ **Smooth Animations**: Smooth animations for open/close
- ✅ **Keyboard Navigation**: Tab key navigation support
- ✅ **Modal.confirm()**: Static method for confirmation dialogs
- ✅ **Button Props**: Support for okButtonProps and cancelButtonProps styling
- ✅ **No Arco Dependencies**: 100% custom implementation

---

## Functions

The Modal component serves as:

1. **Dialog Display**: Display dialogs and modals throughout the app (declarative)
2. **Imperative Modals**: Open/close modals programmatically via Modal.open()
3. **Multi-Modal Management**: Show multiple modals simultaneously
4. **User Confirmation**: Confirmation dialogs via Modal.confirm()
5. **Form Modals**: Form input modals
6. **Information Display**: Display information in modals

---

## Where It's Used

### Primary Usage

Used extensively throughout the app for modals:

- `src/components/DeleteModal/index.tsx` - Used in delete modal
- `src/components/CreateBranchModal/index.tsx` - Used in create branch modal
- `src/components/GlobalModal/component/FormModal.tsx` - Used in form modal
- And many other components

```tsx
// Used throughout the app
import Modal from "@src/scaffold/ModalSystem";

<Modal
  visible={showModal}
  title="Modal Title"
  onClose={() => setShowModal(false)}
>
  Modal content
</Modal>;
```

---

## How to Use

### Basic Usage

```tsx
import { useState } from "react";

import Modal from "@src/scaffold/ModalSystem";

function MyComponent() {
  const [showModal, setShowModal] = useState(false);

  return (
    <>
      <button onClick={() => setShowModal(true)}>Open Modal</button>
      <Modal
        visible={showModal}
        title="My Modal"
        onClose={() => setShowModal(false)}
      >
        <div>Modal content here</div>
      </Modal>
    </>
  );
}
```

### With Footer

```tsx
<Modal
  visible={showModal}
  title="Confirm Action"
  footer={
    <div className="flex justify-end gap-2">
      <Button onClick={handleCancel}>Cancel</Button>
      <Button onClick={handleConfirm}>Confirm</Button>
    </div>
  }
  onClose={() => setShowModal(false)}
>
  Are you sure you want to proceed?
</Modal>
```

### With onOk/onCancel (Auto Footer)

```tsx
<Modal
  visible={showModal}
  title="Modal"
  onOk={handleOk}
  onCancel={handleCancel}
  okText="OK"
  cancelText="Cancel"
>
  Content
</Modal>
```

**Note**: When `onOk` is provided without a custom `footer`, the modal auto-generates OK/Cancel buttons.

### With Button Props

```tsx
<Modal
  visible={showModal}
  title="Delete Item"
  onOk={handleDelete}
  onCancel={handleCancel}
  okText="Delete"
  okButtonProps={{ status: "danger", loading: isDeleting }}
  cancelButtonProps={{ disabled: isDeleting }}
>
  Are you sure you want to delete this item?
</Modal>
```

### Different Sizes

```tsx
<Modal visible={showModal} size="small">Small modal</Modal>
<Modal visible={showModal} size="medium">Medium modal</Modal>
<Modal visible={showModal} size="large">Large modal</Modal>
<Modal visible={showModal} size="fullscreen">Fullscreen modal</Modal>
```

### Custom Radius

```tsx
<Modal visible={showModal} radius={20} onClose={() => setShowModal(false)}>
  Custom styled modal
</Modal>
```

### Modal.open() - Imperative API

```tsx
import Modal from "@src/scaffold/ModalSystem";

// Open modal imperatively
const modalId = Modal.open({
  title: "My Modal",
  content: <div>Modal content here</div>,
  width: "600px",
  onClose: () => {
    console.log("Modal closed");
  },
});

// Close specific modal
Modal.close(modalId);

// Close all modals
Modal.closeAll();

// Multiple modals simultaneously
const modal1 = Modal.open({ title: "Modal 1", content: <div>First</div> });
const modal2 = Modal.open({ title: "Modal 2", content: <div>Second</div> });
// Both modals are shown at the same time
```

### Modal.confirm() Static Method

```tsx
import Modal from "@src/scaffold/ModalSystem";

// Simple confirmation
Modal.confirm({
  title: "Confirm Action",
  content: "Are you sure you want to proceed?",
  onOk: () => {
    console.log("Confirmed");
  },
});

// With type and custom text
Modal.confirm({
  title: "Delete Item",
  content: "This action cannot be undone.",
  type: "error",
  okText: "Delete",
  cancelText: "Cancel",
  onOk: async () => {
    await deleteItem();
  },
});

// Hide cancel button
Modal.confirm({
  title: "Success",
  content: "Operation completed successfully.",
  type: "success",
  hideCancel: true,
  onOk: () => {},
});
```

---

## API Reference

### Props

| Prop                | Type                                             | Default    | Description                                         |
| ------------------- | ------------------------------------------------ | ---------- | --------------------------------------------------- |
| `visible`           | `boolean`                                        | -          | Modal visibility                                    |
| `onClose`           | `() => void`                                     | -          | Close handler                                       |
| `onCancel`          | `() => void`                                     | -          | Cancel handler (same as onClose)                    |
| `onOk`              | `() => void \| Promise<void>`                    | -          | OK handler (auto-generates footer if no custom one) |
| `title`             | `React.ReactNode`                                | -          | Modal title                                         |
| `children`          | `React.ReactNode`                                | -          | Modal content                                       |
| `footer`            | `React.ReactNode`                                | -          | Footer content (buttons, etc)                       |
| `okText`            | `string`                                         | `"OK"`     | OK button text                                      |
| `cancelText`        | `string`                                         | `"Cancel"` | Cancel button text                                  |
| `okButtonProps`     | `{ status?, loading?, disabled? }`               | -          | OK button styling props                             |
| `cancelButtonProps` | `{ disabled? }`                                  | -          | Cancel button styling props                         |
| `closeIcon`         | `React.ReactNode`                                | -          | Custom close icon                                   |
| `className`         | `string`                                         | `""`       | Additional CSS classes                              |
| `closable`          | `boolean`                                        | `true`     | Show close button                                   |
| `maskClosable`      | `boolean`                                        | `true`     | Click outside to close                              |
| `escToExit`         | `boolean`                                        | `true`     | ESC key to close                                    |
| `radius`            | `number`                                         | `16`       | Border radius in pixels                             |
| `width`             | `number \| string`                               | -          | Modal width                                         |
| `size`              | `"small" \| "medium" \| "large" \| "fullscreen"` | -          | Modal size preset                                   |
| `zIndex`            | `number`                                         | `9999`     | z-index                                             |
| `style`             | `React.CSSProperties`                            | -          | Custom inline styles                                |

### okButtonProps

| Prop       | Type                                              | Description        |
| ---------- | ------------------------------------------------- | ------------------ |
| `status`   | `"danger" \| "warning" \| "success" \| "default"` | Button color style |
| `loading`  | `boolean`                                         | Show loading state |
| `disabled` | `boolean`                                         | Disable the button |

### Modal.confirm() Config

```typescript
interface ConfirmModalConfig {
  title?: React.ReactNode; // Dialog title
  content?: React.ReactNode; // Dialog content/message
  okText?: string; // OK button text (default: "OK")
  cancelText?: string; // Cancel button text (default: "Cancel")
  onOk?: () => void | Promise<void>; // OK callback (supports async)
  onCancel?: () => void; // Cancel callback
  type?: "info" | "success" | "warning" | "error"; // Dialog type (default: "info")
  hideCancel?: boolean; // Hide cancel button (default: false)
}
```

**Returns**: `{ close: () => void }` - Object with close method

---

## Implementation Details

### Portal Rendering

- **Portal**: Uses `createPortal` to render to `document.body`
- **Z-Index**: Configurable z-index (default: 9999)
- **Layering**: Proper z-index management above all content

### Focus Management

- **Focus Trap**: Keeps focus within modal when open
- **Tab Navigation**: Wraps focus from last to first element (and vice versa)
- **Auto-Focus**: Auto-focuses first focusable element on open
- **Focus Restoration**: Returns focus to previously focused element on close

### Body Scroll Lock

- **Prevents Scrolling**: Sets `document.body.style.overflow = "hidden"`
- **Scrollbar Compensation**: Adds padding-right to prevent layout shift
- **Cleanup**: Restores on unmount

### Keyboard Handling

- **ESC Key**: Closes modal when `escToExit={true}` (default)
- **Tab Key**: Traps focus within modal
- **Enter/Space**: Activates focused button

### Jotai Store Integration

- **Shared State**: Modal.open() and Modal.confirm() use `getInstrumentedStore()` to share Jotai state with the main app
- **Provider Wrapping**: Imperatively created modals are wrapped in `<Provider store={store}>` for state access

### Modal.confirm() Implementation

- **Imperative API**: Creates modal imperatively (no React component)
- **Container**: Creates DOM container and React root
- **Rendering**: Uses `createRoot` and `render` for React 18+
- **Cleanup**: Unmounts and removes container after animation
- **Animation**: 300ms delay for close animation
- **Icons**: Type-based icons using Lucide (CheckCircle2, AlertTriangle, XCircle, Info)
- **Loading State**: Shows "..." when `onOk` is async

### Confirm Modal Types

- **Info**: Blue info icon (default)
- **Success**: Green check icon
- **Warning**: Amber alert icon
- **Error**: Red close icon

### Visual Design

- **Backdrop/Mask**: Semi-transparent backdrop (60% black, 70% in dark mode)
- **Container**: Centered container with flex layout
- **Content**: Solid `bg-2` background with shadow
- **Header**: Title and close button with border separator
- **Body**: Content area with smooth scrolling
- **Footer**: Optional footer area with border separator

### Accessibility

- **ARIA**: `role="dialog"`, `aria-modal="true"`
- **ARIA Label**: `aria-labelledby` when title present
- **Focus Trap**: Ensures keyboard navigation stays within modal
- **Close Label**: `aria-label="Close modal"` on close button
- **High Contrast**: Supports `prefers-contrast: high`

### Dependencies

- `react-dom` - createPortal, createRoot
- `jotai` - Provider for state sharing
- `lucide-react` - Icons for confirm dialogs
- `./index.scss` - Component styles

---

## Modal Variants

The ModalSystem includes several specialized modal variants:

- `variants/QuickUpload/` - File upload modal
- `variants/Rename/` - Rename modal
- `variants/AddFunds/` - Add funds modal
- `variants/ContentView/` - Content viewing modal
- `variants/BackgroundCustomizer/` - Background customization modal

---

## Related Files

- `src/scaffold/ModalSystem/index.tsx` - Main component implementation
- `src/scaffold/ModalSystem/index.scss` - Component styles
- `src/scaffold/ModalSystem/variants/` - Modal variant implementations

---

## Usage Example

```tsx
import Modal from "@src/scaffold/ModalSystem";

<Modal visible={visible} onClose={onCancel}>
  ...
</Modal>;

// Modal.confirm() works the same way
Modal.confirm({
  title: "Confirm",
  content: "Are you sure?",
  onOk: handleOk,
});
```

---

**Last Updated**: January 29, 2026  
**Status**: ✅ Production Ready
