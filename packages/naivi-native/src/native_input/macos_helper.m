// macOS native text-input helper.
// Compiled via cc crate in build.rs with -fobjc-arc.
// All AppKit calls are wrapped in @try/@catch so ObjC exceptions never
// propagate through the Rust FFI boundary (chartles pattern).

#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <objc/runtime.h>

// ---------------------------------------------------------------------------
// Callbacks into Rust
// ---------------------------------------------------------------------------
typedef void (*value_changed_fn)(void *ctx, uint64_t node_id, const char *text);
typedef void (*committed_fn)(void *ctx, uint64_t node_id, const char *text);
typedef void (*submit_fn)(void *ctx, uint64_t node_id);
typedef void (*tab_fn)(void *ctx, uint64_t node_id, int shift);
typedef void (*key_fn)(void *ctx, uint64_t node_id, const char *key, const char *code);

// The handle: the control + the Rust callbacks/ctx.
typedef struct {
    __unsafe_unretained NSView *parent;
    NSView *control;          // NSTextField/NSSecureTextField (single) or NSScrollView->NSTextView (multi)
    NSTextView *textView;     // non-nil for multiline
    int multiline;
    int secure;
    BOOL isProgrammatic;
    uint64_t node_id;
    void *ctx;
    value_changed_fn on_value_changed;
    committed_fn on_committed;
    submit_fn on_submit;
    tab_fn on_tab;
    key_fn on_key_down;
    key_fn on_key_up;
} NativeInputHandle;

// AppKit uses a bottom-left origin; blitz reports top-left window coordinates,
// so the y is flipped by the parent view's height.
static double flip_y(NativeInputHandle *h, double y, double height) {
    double parent_h = h->parent != nil ? h->parent.bounds.size.height : 0.0;
    return parent_h - y - height;
}

static char *_textBuffer = NULL;
static void set_text_buffer(const char *text) {
    free(_textBuffer);
    _textBuffer = NULL;
    if (text != NULL) _textBuffer = strdup(text);
}

// ---------------------------------------------------------------------------
// Delegate (NSTextField and NSTextView)
// ---------------------------------------------------------------------------
@interface NativeInputDelegate : NSObject <NSTextFieldDelegate, NSTextViewDelegate>
@property(nonatomic, assign) NativeInputHandle *handle;
@end

@implementation NativeInputDelegate

- (void)controlTextDidChange:(NSNotification *)notification {
    NativeInputHandle *h = self.handle;
    if (h == NULL || h->isProgrammatic || h->on_value_changed == NULL) return;
    @autoreleasepool {
        NSTextField *field = (NSTextField *)notification.object;
        const char *utf8 = field.stringValue.UTF8String;
        h->on_value_changed(h->ctx, h->node_id, utf8 != NULL ? utf8 : "");
    }
}

- (void)controlTextDidEndEditing:(NSNotification *)notification {
    NativeInputHandle *h = self.handle;
    if (h == NULL || h->on_committed == NULL) return;
    @autoreleasepool {
        NSTextField *field = (NSTextField *)notification.object;
        const char *utf8 = field.stringValue.UTF8String;
        h->on_committed(h->ctx, h->node_id, utf8 != NULL ? utf8 : "");
    }
}

- (void)textDidChange:(NSNotification *)notification {
    NativeInputHandle *h = self.handle;
    if (h == NULL || h->isProgrammatic || h->on_value_changed == NULL) return;
    @autoreleasepool {
        NSTextView *view = (NSTextView *)notification.object;
        const char *utf8 = view.string.UTF8String;
        h->on_value_changed(h->ctx, h->node_id, utf8 != NULL ? utf8 : "");
    }
}

- (void)textDidEndEditing:(NSNotification *)notification {
    NativeInputHandle *h = self.handle;
    if (h == NULL || h->on_committed == NULL) return;
    @autoreleasepool {
        NSTextView *view = (NSTextView *)notification.object;
        const char *utf8 = view.string.UTF8String;
        h->on_committed(h->ctx, h->node_id, utf8 != NULL ? utf8 : "");
    }
}

// Map a command selector to a (key, code) pair for guest forwarding (KTD8).
// Returns NO when the selector has no meaningful key mapping.
static BOOL key_for_selector(SEL commandSelector, const char **key, const char **code) {
    if (commandSelector == @selector(insertNewline:)) { *key = "Enter"; *code = "Enter"; return YES; }
    if (commandSelector == @selector(insertTab:)) { *key = "Tab"; *code = "Tab"; return YES; }
    if (commandSelector == @selector(insertBacktab:)) { *key = "Tab"; *code = "Tab"; return YES; }
    if (commandSelector == @selector(cancelOperation:)) { *key = "Escape"; *code = "Escape"; return YES; }
    if (commandSelector == @selector(moveUp:)) { *key = "ArrowUp"; *code = "ArrowUp"; return YES; }
    if (commandSelector == @selector(moveDown:)) { *key = "ArrowDown"; *code = "ArrowDown"; return YES; }
    if (commandSelector == @selector(moveLeft:)) { *key = "ArrowLeft"; *code = "ArrowLeft"; return YES; }
    if (commandSelector == @selector(moveRight:)) { *key = "ArrowRight"; *code = "ArrowRight"; return YES; }
    if (commandSelector == @selector(deleteBackward:)) { *key = "Backspace"; *code = "Backspace"; return YES; }
    if (commandSelector == @selector(deleteForward:)) { *key = "Delete"; *code = "Delete"; return YES; }
    return NO;
}

- (BOOL)handleCommandSelector:(SEL)commandSelector {
    NativeInputHandle *h = self.handle;
    if (h == NULL) return NO;
    if (commandSelector == @selector(insertTab:) || commandSelector == @selector(insertBacktab:)) {
        if (h->on_tab) h->on_tab(h->ctx, h->node_id, commandSelector == @selector(insertBacktab:) ? 1 : 0);
        return YES;
    }
    if (commandSelector == @selector(insertNewline:) && !h->multiline) {
        // Mirror the wasm backend: forward the full key sequence before
        // `Submit` ends the session so the guest's `@keyup.enter` fires (KTD8).
        if (h->on_key_down) h->on_key_down(h->ctx, h->node_id, "Enter", "Enter");
        if (h->on_key_up) h->on_key_up(h->ctx, h->node_id, "Enter", "Enter");
        if (h->on_submit) h->on_submit(h->ctx, h->node_id);
        return YES;
    }
    const char *key = NULL;
    const char *code = NULL;
    if (key_for_selector(commandSelector, &key, &code)) {
        // Forward special keys (Escape, arrows, …) so guest @keyup.* / @keydown.*
        // handlers keep working during the session (KTD8); the default action
        // still runs (return NO).
        if (h->on_key_down) h->on_key_down(h->ctx, h->node_id, key, code);
        if (h->on_key_up) h->on_key_up(h->ctx, h->node_id, key, code);
    }
    return NO;
}

- (BOOL)control:(NSControl *)control textView:(NSTextView *)textView doCommandBySelector:(SEL)commandSelector {
    return [self handleCommandSelector:commandSelector];
}

- (BOOL)textView:(NSTextView *)textView doCommandBySelector:(SEL)commandSelector {
    return [self handleCommandSelector:commandSelector];
}

@end

// ---------------------------------------------------------------------------
// Public C API
// ---------------------------------------------------------------------------

void *native_input_create(void *nsViewPtr, double x, double y, double w, double h,
                          int multiline, int secure, uint64_t node_id) {
    @autoreleasepool {
        @try {
            NSView *parent = (__bridge NSView *)nsViewPtr;
            if (parent == nil) return NULL;

            NativeInputHandle *handle = calloc(1, sizeof(NativeInputHandle));
            handle->parent = parent;
            handle->multiline = multiline;
            handle->secure = secure;
            handle->node_id = node_id;
            handle->isProgrammatic = NO;

            NativeInputDelegate *delegate = [[NativeInputDelegate alloc] init];
            delegate.handle = handle;

            if (multiline) {
                double fy = flip_y(handle, y, h);
                NSScrollView *scroll = [[NSScrollView alloc] initWithFrame:NSMakeRect(x, fy, w, h)];
                scroll.hasVerticalScroller = YES;
                scroll.hasHorizontalScroller = NO;
                scroll.borderType = NSNoBorder;
                NSTextView *textView = [[NSTextView alloc] initWithFrame:scroll.contentView.bounds];
                textView.richText = NO;
                textView.horizontallyResizable = NO;
                textView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
                textView.delegate = delegate;
                NSTextContainer *tc = textView.textContainer;
                tc.widthTracksTextView = YES;
                tc.containerSize = NSMakeSize(scroll.contentSize.width, CGFLOAT_MAX);
                scroll.documentView = textView;
                [parent addSubview:scroll];
                handle->control = scroll;
                handle->textView = textView;
            } else {
                double fy = flip_y(handle, y, h);
                NSTextField *field;
                if (secure) {
                    field = [[NSSecureTextField alloc] initWithFrame:NSMakeRect(x, fy, w, h)];
                } else {
                    field = [[NSTextField alloc] initWithFrame:NSMakeRect(x, fy, w, h)];
                }
                field.bezeled = NO;
                field.bordered = NO;
                field.drawsBackground = YES;
                field.editable = YES;
                field.delegate = delegate;
                [parent addSubview:field];
                handle->control = (NSView *)field;
            }

            // Keep the delegate alive for the handle's lifetime (retain).
            objc_setAssociatedObject(handle->control, "nativeInputDelegate", delegate, OBJC_ASSOCIATION_RETAIN_NONATOMIC);

            return handle;
        } @catch (NSException *e) {
            NSLog(@"native_input_create error: %@", e.reason);
            return NULL;
        }
    }
}

void native_input_destroy(void *handlePtr) {
    if (handlePtr == NULL) return;
    @autoreleasepool {
        @try {
            NativeInputHandle *handle = (NativeInputHandle *)handlePtr;
            // Nil the callbacks before tearing the control down so a delegate
            // callback firing during/after removal (e.g. textDidEndEditing)
            // cannot dereference this handle (UAF guard).
            handle->on_value_changed = NULL;
            handle->on_committed = NULL;
            handle->on_submit = NULL;
            handle->on_tab = NULL;
            handle->on_key_down = NULL;
            handle->on_key_up = NULL;
            [handle->control removeFromSuperview];
            // Under ARC, the `control`/`textView` fields are strong; niling
            // them releases the NSTextField/NSScrollView+NSTextView and the
            // associated delegate (leak fix for repeated focus/Tab cycles).
            handle->textView = nil;
            handle->control = nil;
            free(handle);
        } @catch (NSException *e) {
            NSLog(@"native_input_destroy error: %@", e.reason);
        }
    }
}

void native_input_set_value(void *handlePtr, const char *text) {
    if (handlePtr == NULL) return;
    @autoreleasepool {
        @try {
            NativeInputHandle *handle = (NativeInputHandle *)handlePtr;
            handle->isProgrammatic = YES;
            NSString *s = [NSString stringWithUTF8String:text != NULL ? text : ""];
            if (handle->multiline) {
                // Preserve the caret/selection across the programmatic set (R5,
                // KTD6) — matches the wasm backend's set_preserving_selection.
                NSRange sel = handle->textView.selectedRange;
                handle->textView.string = s;
                NSUInteger len = s.length;
                if (sel.location > len) sel.location = len;
                if (sel.location + sel.length > len) sel.length = len - sel.location;
                handle->textView.selectedRange = sel;
            } else {
                NSTextField *field = (NSTextField *)handle->control;
                NSTextView *editor = field.currentEditor;
                NSRange sel = editor != nil ? editor.selectedRange : NSMakeRange(0, 0);
                if (editor != nil) {
                    editor.string = s;
                    NSUInteger len = s.length;
                    if (sel.location > len) sel.location = len;
                    if (sel.location + sel.length > len) sel.length = len - sel.location;
                    editor.selectedRange = sel;
                } else {
                    field.stringValue = s;
                }
            }
            handle->isProgrammatic = NO;
        } @catch (NSException *e) {
            NSLog(@"native_input_set_value error: %@", e.reason);
        }
    }
}

const char *native_input_get_value(void *handlePtr) {
    if (handlePtr == NULL) return "";
    @autoreleasepool {
        @try {
            NativeInputHandle *handle = (NativeInputHandle *)handlePtr;
            const char *utf8 = NULL;
            if (handle->multiline) {
                utf8 = handle->textView.string.UTF8String;
            } else {
                NSTextField *field = (NSTextField *)handle->control;
                if (field.currentEditor != nil) {
                    utf8 = field.currentEditor.string.UTF8String;
                } else {
                    utf8 = field.stringValue.UTF8String;
                }
            }
            set_text_buffer(utf8 != NULL ? utf8 : "");
            return _textBuffer != NULL ? _textBuffer : "";
        } @catch (NSException *e) {
            NSLog(@"native_input_get_value error: %@", e.reason);
            return "";
        }
    }
}

void native_input_set_frame(void *handlePtr, double x, double y, double w, double h) {
    if (handlePtr == NULL) return;
    @autoreleasepool {
        @try {
            NativeInputHandle *handle = (NativeInputHandle *)handlePtr;
            handle->control.frame = NSMakeRect(x, flip_y(handle, y, h), w, h);
        } @catch (NSException *e) {
            NSLog(@"native_input_set_frame error: %@", e.reason);
        }
    }
}

void native_input_focus(void *handlePtr) {
    if (handlePtr == NULL) return;
    @autoreleasepool {
        @try {
            NativeInputHandle *handle = (NativeInputHandle *)handlePtr;
            if (handle->multiline) {
                [handle->textView.window makeFirstResponder:handle->textView];
            } else {
                NSTextField *field = (NSTextField *)handle->control;
                [field.window makeFirstResponder:field];
            }
        } @catch (NSException *e) {
            NSLog(@"native_input_focus error: %@", e.reason);
        }
    }
}

void native_input_set_font(void *handlePtr, const char *family, double size, double weight) {
    if (handlePtr == NULL) return;
    @autoreleasepool {
        @try {
            NativeInputHandle *handle = (NativeInputHandle *)handlePtr;
            NSFont *font = [NSFont systemFontOfSize:size > 0 ? size : 13.0];
            if (family != NULL && strlen(family) > 0) {
                // The CSS font stack is a comma-joined list ("Noto Sans, sans-serif");
                // fontWithName: needs a single PostScript name, so take the first
                // usable family (R12).
                NSArray<NSString *> *parts = [[NSString stringWithUTF8String:family] componentsSeparatedByString:@","];
                for (NSString *part in parts) {
                    NSString *trimmed = [part stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
                    trimmed = [trimmed stringByTrimmingCharactersInSet:[NSCharacterSet characterSetWithCharactersInString:@"\"'"] ];
                    if (trimmed.length == 0) continue;
                    if ([trimmed.lowercaseString isEqualToString:@"sans-serif"] ||
                        [trimmed.lowercaseString isEqualToString:@"serif"] ||
                        [trimmed.lowercaseString isEqualToString:@"monospace"] ||
                        [trimmed.lowercaseString isEqualToString:@"cursive"] ||
                        [trimmed.lowercaseString isEqualToString:@"fantasy"]) continue;
                    NSFont *named = [NSFont fontWithName:trimmed size:size > 0 ? size : 13.0];
                    if (named != nil) { font = named; break; }
                }
            }
            if (handle->multiline) {
                handle->textView.font = font;
            } else {
                ((NSTextField *)handle->control).font = font;
            }
        } @catch (NSException *e) {
            NSLog(@"native_input_set_font error: %@", e.reason);
        }
    }
}

void native_input_set_text_color(void *handlePtr, double r, double g, double b, double a) {
    if (handlePtr == NULL) return;
    @autoreleasepool {
        @try {
            NativeInputHandle *handle = (NativeInputHandle *)handlePtr;
            NSColor *color = [NSColor colorWithSRGBRed:r green:g blue:b alpha:a];
            if (handle->multiline) {
                handle->textView.textColor = color;
            } else {
                ((NSTextField *)handle->control).textColor = color;
            }
        } @catch (NSException *e) {
            NSLog(@"native_input_set_text_color error: %@", e.reason);
        }
    }
}

void native_input_set_background(void *handlePtr, double r, double g, double b, double a) {
    if (handlePtr == NULL) return;
    @autoreleasepool {
        @try {
            NativeInputHandle *handle = (NativeInputHandle *)handlePtr;
            NSColor *color = [NSColor colorWithSRGBRed:r green:g blue:b alpha:a];
            if (handle->multiline) {
                handle->textView.backgroundColor = color;
                handle->textView.drawsBackground = YES;
            } else {
                NSTextField *field = (NSTextField *)handle->control;
                field.drawsBackground = YES;
                field.backgroundColor = color;
            }
        } @catch (NSException *e) {
            NSLog(@"native_input_set_background error: %@", e.reason);
        }
    }
}

void native_input_set_placeholder(void *handlePtr, const char *text) {
    if (handlePtr == NULL) return;
    @autoreleasepool {
        @try {
            NativeInputHandle *handle = (NativeInputHandle *)handlePtr;
            if (!handle->multiline) {
                NSTextField *field = (NSTextField *)handle->control;
                field.placeholderString = text != NULL ? [NSString stringWithUTF8String:text] : @"";
            }
        } @catch (NSException *e) {
            NSLog(@"native_input_set_placeholder error: %@", e.reason);
        }
    }
}

void native_input_set_editable(void *handlePtr, int editable, int enabled) {
    if (handlePtr == NULL) return;
    @autoreleasepool {
        @try {
            NativeInputHandle *handle = (NativeInputHandle *)handlePtr;
            if (handle->multiline) {
                handle->textView.editable = editable;
                handle->textView.selectable = editable;
            } else {
                NSTextField *field = (NSTextField *)handle->control;
                field.editable = editable;
                field.selectable = editable;
                field.enabled = enabled;
            }
        } @catch (NSException *e) {
            NSLog(@"native_input_set_editable error: %@", e.reason);
        }
    }
}

void native_input_set_callbacks(void *handlePtr, void *ctx,
                                value_changed_fn valueChanged, committed_fn committed,
                                submit_fn submit, tab_fn tab,
                                key_fn keyDown, key_fn keyUp) {
    if (handlePtr == NULL) return;
    NativeInputHandle *handle = (NativeInputHandle *)handlePtr;
    handle->ctx = ctx;
    handle->on_value_changed = valueChanged;
    handle->on_committed = committed;
    handle->on_submit = submit;
    handle->on_tab = tab;
    handle->on_key_down = keyDown;
    handle->on_key_up = keyUp;
}
